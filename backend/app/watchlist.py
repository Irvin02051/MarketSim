"""User-scoped Data API access; database RLS remains authoritative."""
import asyncio
import os
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, field_validator

from app.auth import VerifiedContext, auth_error, project_configuration, require_context
from app.market_data import QuoteError, normalize_symbol

WATCHLIST_DEADLINE = 10.0


def failure(status: int) -> HTTPException:
    messages = {403: 'Watchlist access denied.', 409: 'Symbol is already saved.',
                422: 'Supply only a supported symbol: AAPL, MSFT, or NVDA.',
                503: 'Watchlist service is unavailable. A write may have completed; refresh before retrying.'}
    return HTTPException(status, messages[status], headers={'Cache-Control': 'no-store'})


class WatchlistRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            try:
                response = await asyncio.wait_for(handler(request), WATCHLIST_DEADLINE)
            except asyncio.TimeoutError:
                error = failure(503)
                response = JSONResponse({'detail': error.detail}, status_code=503)
            except RequestValidationError:
                # Do not echo client input (which may contain credentials).
                response = JSONResponse({'detail': failure(422).detail}, status_code=422)
            except HTTPException as error:
                response = JSONResponse({'detail': error.detail}, status_code=error.status_code,
                                        headers=error.headers)
            response.headers['Cache-Control'] = 'no-store'
            return response

        return bounded


class WatchlistInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    symbol: str

    @field_validator('symbol')
    @classmethod
    def supported_symbol(cls, value: str) -> str:
        try:
            return normalize_symbol(value.strip())
        except QuoteError:
            raise ValueError('Unsupported symbol') from None


class WatchlistItem(BaseModel):
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    created_at: datetime


class WatchlistResult(BaseModel):
    items: list[WatchlistItem]


class WatchlistService:
    def __init__(self, client: httpx.AsyncClient, url: str, key: str):
        self.client = client
        config = project_configuration(url, key)
        self.endpoint = config[0] + '/rest/v1/watchlist_items' if config else None
        self._key = config[1] if config else ''

    @classmethod
    def configured(cls, client: httpx.AsyncClient) -> 'WatchlistService':
        return cls(client, os.getenv('SUPABASE_URL', ''), os.getenv('SUPABASE_PUBLISHABLE_KEY', ''))

    async def execute(self, method: str, context: VerifiedContext, symbol: str | None = None) -> list[WatchlistItem]:
        if not self.endpoint:
            raise failure(503)
        params = {'select': 'user_id,symbol,created_at'}
        if method in ('GET', 'DELETE'):
            params['user_id'] = f'eq.{context.user_id}'
        if method == 'GET':
            params['order'] = 'symbol.asc'
        if method == 'DELETE':
            params['symbol'] = f'eq.{symbol}'
        # Representations allow ownership validation for writes too. Never upsert.
        headers = {'apikey': self._key, 'Authorization': f'Bearer {context.token.get_secret_value()}',
                   'Prefer': 'return=representation'}
        if method == 'POST':
            headers['Prefer'] += ', missing=default'
        kwargs = {'json': {'user_id': str(context.user_id), 'symbol': symbol}} if method == 'POST' else {}
        try:
            response = await self.client.request(method, self.endpoint, params=params, headers=headers, **kwargs)
        except httpx.HTTPError:
            raise failure(503) from None
        try:
            body = response.json()
        except (ValueError, UnicodeError):
            raise failure(503) from None
        expected = 201 if method == 'POST' else 200
        if response.status_code != expected:
            code = body.get('code') if isinstance(body, dict) else None
            if 400 <= response.status_code < 500 and response.status_code != 429:
                if code == '23505' and method == 'POST':
                    raise failure(409)
                if code == '42501':
                    raise failure(403)
                if code in ('PGRST301', 'PGRST302', 'PGRST303'):
                    raise auth_error(401)
            raise failure(503)
        if not isinstance(body, list) or len(body) > 3 or (method == 'POST' and len(body) != 1):
            raise failure(503)
        if method == 'DELETE' and len(body) > 1:
            raise failure(503)
        items = []
        seen = set()
        for row in body:
            try:
                if not isinstance(row, dict) or not isinstance(row.get('user_id'), str):
                    raise TypeError
                if UUID(row['user_id']) != context.user_id:
                    raise ValueError
                value, timestamp = row.get('symbol'), row.get('created_at')
                if not isinstance(value, str) or value != normalize_symbol(value) or value in seen:
                    raise ValueError
                if symbol is not None and value != symbol:
                    raise ValueError
                if not isinstance(timestamp, str):
                    raise TypeError
                parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                if parsed.tzinfo is None or parsed.utcoffset() is None:
                    raise ValueError
                items.append(WatchlistItem(symbol=value, created_at=parsed))
                seen.add(value)
            except (TypeError, ValueError, QuoteError):
                raise failure(503) from None
        return sorted(items, key=lambda item: item.symbol)


router = APIRouter(route_class=WatchlistRoute, responses={
    401: {'description': 'Missing or rejected credential'}, 403: {'description': 'Access denied'},
    503: {'description': 'Service unavailable; write outcome may be uncertain'},
})
Context = Annotated[VerifiedContext, Depends(require_context)]


@router.get('/api/watchlist', response_model=WatchlistResult)
async def list_watchlist(request: Request, context: Context) -> WatchlistResult:
    return WatchlistResult(items=await request.app.state.watchlist.execute('GET', context))


@router.post('/api/watchlist', response_model=WatchlistItem, status_code=201,
             responses={409: {'description': 'Symbol already saved'}})
async def add_watchlist(body: WatchlistInput, request: Request, context: Context) -> WatchlistItem:
    return (await request.app.state.watchlist.execute('POST', context, body.symbol))[0]


@router.delete('/api/watchlist/{symbol}', status_code=204)
async def remove_watchlist(symbol: str, request: Request, context: Context) -> Response:
    try:
        validated = WatchlistInput(symbol=symbol)
    except ValueError:
        raise failure(422) from None
    await request.app.state.watchlist.execute('DELETE', context, validated.symbol)
    return Response(status_code=204)
