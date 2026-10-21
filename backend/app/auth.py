"""Online user identity verification; no local JWT claims are trusted."""

import asyncio
import os
import re
from uuid import UUID

import httpx
from fastapi import HTTPException, Request
from pydantic import BaseModel

MAX_CREDENTIAL_LENGTH = 8192  # Entire Authorization header, in ASCII characters.
VERIFICATION_DEADLINE = 5.0
REJECTED_CODES = frozenset({
    'bad_jwt', 'no_authorization', 'session_expired', 'session_not_found',
    'user_banned', 'user_not_found',
})


class Identity(BaseModel):
    user_id: UUID


def auth_error(status: int) -> HTTPException:
    headers = {'Cache-Control': 'no-store'}
    if status == 401:
        headers['WWW-Authenticate'] = 'Bearer'
    return HTTPException(status_code=status, headers=headers, detail=(
        'Invalid or missing authentication credentials.' if status == 401
        else 'Identity verification is unavailable.'
    ))


def bearer_token(headers: list[str]) -> str:
    if len(headers) != 1 or len(headers[0]) > MAX_CREDENTIAL_LENGTH:
        raise auth_error(401)
    match = re.fullmatch(r'(?i:Bearer) +([A-Za-z0-9._~+/-]+=*)', headers[0])
    if match is None:
        raise auth_error(401)
    return match[1]


class IdentityVerifier:
    def __init__(self, client: httpx.AsyncClient, url: str, key: str):
        self.client = client
        # Deliberately hosted-project only; custom domains/local Auth are out of scope.
        valid_url = re.fullmatch(r'https://[a-z0-9]+\.supabase\.co/?', url)
        valid_key = re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key)
        self.endpoint = url.rstrip('/') + '/auth/v1/user' if valid_url and valid_key else None
        self._key = key if self.endpoint else ''

    @classmethod
    def configured(cls, client: httpx.AsyncClient) -> 'IdentityVerifier':
        return cls(client, os.getenv('SUPABASE_URL', ''), os.getenv('SUPABASE_PUBLISHABLE_KEY', ''))

    async def verify(self, token: str) -> Identity:
        if self.endpoint is None:
            raise auth_error(503)
        try:
            # HTTPX get reads the body before returning; wait_for also bounds pool waits
            # and slow streaming responses. CancelledError deliberately propagates.
            response = await asyncio.wait_for(self.client.get(self.endpoint, headers={
                'apikey': self._key, 'Authorization': f'Bearer {token}',
            }), timeout=VERIFICATION_DEADLINE)
        except (httpx.HTTPError, asyncio.TimeoutError):
            raise auth_error(503) from None
        try:
            body = response.json()
        except (ValueError, UnicodeError):
            raise auth_error(503) from None
        if response.status_code != 200:
            code = body.get('code') if isinstance(body, dict) else None
            if (400 <= response.status_code < 500 and response.status_code != 429
                    and isinstance(code, str) and code in REJECTED_CODES):
                raise auth_error(401)
            raise auth_error(503)
        if not isinstance(body, dict) or not isinstance(body.get('id'), str):
            raise auth_error(503)
        try:
            user_id = UUID(body['id'])
        except ValueError:
            raise auth_error(503) from None
        return Identity(user_id=user_id)


async def require_identity(request: Request) -> Identity:
    token = bearer_token(request.headers.getlist('authorization'))
    return await request.app.state.identity.verify(token)
