import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.auth import Identity, IdentityVerifier, require_identity
from app.gemini_client import configured_client
from app.historical_data import HistoricalInput, HistoricalResult, get_history
from app.market_data import MarketData, ProviderBudget, Quote, QuoteError
from app.real_history import (
    HistoricalService,
    HistoryError,
    HistoryRequest,
    RealHistoryResult,
)
from app.research_agent import AgentInput, AgentResult, ResearchAgent
from app.research_explanation import ResearchExplanation, ResearchInput, ResearchResult
from app.research_explanation import explanation as research_outcome
from app.watchlist import WatchlistService
from app.watchlist import router as watchlist_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # HTTPX INFO logs include request URLs; suppress transport logs containing keys.
    for name in ('httpx', 'httpcore', 'google.genai', 'google.genai._api_client', 'google.genai.models'):
        logging.getLogger(name).disabled = True
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=False,
                                 trust_env=False, limits=httpx.Limits(max_connections=3)) as client, httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=2.0), follow_redirects=False, trust_env=False,
            transport=httpx.AsyncHTTPTransport(retries=0, trust_env=False),
    ) as auth_client, httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=2.0), follow_redirects=False, trust_env=False,
            transport=httpx.AsyncHTTPTransport(retries=0, trust_env=False,
                                             limits=httpx.Limits(max_connections=3)),
    ) as data_client:
        app.state.watchlist = WatchlistService.configured(data_client)
        app.state.identity = IdentityVerifier.configured(auth_client)
        budget = ProviderBudget()
        service = MarketData(client, budget=budget)
        app.state.market_data = service
        app.state.real_history_enabled = os.environ.get('REAL_HISTORY_ENABLED', 'false') == 'true'
        history = HistoricalService(client, budget=budget,
                                    mode='alpha_vantage' if app.state.real_history_enabled else 'demo')
        app.state.historical_data = history
        model = configured_client()
        app.state.research = ResearchExplanation(model)
        app.state.research_agent = ResearchAgent(model)
        try:
            yield
        finally:
            try:
                if model is not None:
                    await model.close()
            finally:
                try:
                    await history.close()
                finally:
                    await service.close()


app = FastAPI(title='MarketSim API', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
    allow_methods=['GET', 'POST', 'DELETE'],
    allow_headers=['Content-Type', 'Authorization'],
    allow_credentials=False,
)

app.include_router(watchlist_router)


@app.get('/api/me', response_model=Identity, responses={
    401: {'description': 'Missing or rejected user credential'},
    503: {'description': 'Identity verification unavailable'},
})
async def get_me(response: Response, identity: Annotated[Identity, Depends(require_identity)]) -> Identity:
    response.headers['Cache-Control'] = 'no-store'
    return identity


@app.get('/health')
def get_health() -> dict[str, str]:
    """Confirm the API responds, without checking external services."""
    return {'status': 'ok', 'service': 'marketsim-api'}


@app.get('/api/stocks/{symbol}/quote', response_model=Quote)
async def get_stock_quote(symbol: str, request: Request) -> Quote:
    try:
        return await request.app.state.market_data.get_quote(symbol)
    except QuoteError as error:
        raise HTTPException(status_code=error.status, detail=error.detail) from None


@app.get('/api/stocks/{symbol}/history', response_model=HistoricalResult)
def get_stock_history(
    symbol: str, request: Request,
    start_date: Annotated[str, Query(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', max_length=10)],
    end_date: Annotated[str, Query(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', max_length=10)],
) -> HistoricalResult:
    """Fictional daily history, independent of quote-provider and research configuration."""
    if set(request.query_params) != {'start_date', 'end_date'} or any(
        len(request.query_params.getlist(name)) != 1 for name in ('start_date', 'end_date')
    ):
        raise HTTPException(status_code=422, detail='Supply only start_date and end_date, once each.')
    try:
        start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(status_code=422, detail='Dates must be valid YYYY-MM-DD dates.') from None
    try:
        validated = HistoricalInput(symbol=symbol, start_date=start, end_date=end)
    except ValidationError:
        raise HTTPException(
            status_code=422,
            detail='Use AAPL, MSFT, or NVDA and an ordered date range of at most two calendar years.',
        ) from None
    return get_history(validated)


@app.get('/api/stocks/{symbol}/history/provider', response_model=RealHistoryResult, responses={
    422: {'description': 'Invalid input or range unavailable; available_range supplied when known'},
    429: {'description': 'Local attempt budget or provider quota exhausted'},
    502: {'description': 'Provider HTTP, connection, malformed data or oversized response error'},
    503: {'description': 'Provider history disabled or configuration unavailable'},
    504: {'description': 'Provider request timed out'},
})
async def get_provider_history(
    symbol: str, request: Request,
    start_date: Annotated[str, Query(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', max_length=10)],
    end_date: Annotated[str, Query(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', max_length=10)],
):
    """Opt-in raw daily history for private local use; this flag is not authentication."""
    if set(request.query_params) != {'start_date', 'end_date'} or any(
        len(request.query_params.getlist(name)) != 1 for name in ('start_date', 'end_date')
    ):
        raise HTTPException(status_code=422, detail='Supply only start_date and end_date, once each.')
    try:
        start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(status_code=422, detail='Dates must be valid YYYY-MM-DD dates.') from None
    try:
        validated = HistoryRequest(symbol=symbol, start_date=start, end_date=end)
    except ValidationError:
        raise HTTPException(status_code=422, detail=(
            'Use AAPL, MSFT, or NVDA and an ordered inclusive range of at most 90 calendar days.'
        )) from None
    if not request.app.state.real_history_enabled:
        raise HTTPException(status_code=503, detail='Provider history is disabled.')
    try:
        return await request.app.state.historical_data.get_history(validated)
    except HistoryError as error:
        content = {'detail': error.detail}
        if error.available_range is not None:
            content['available_range'] = error.available_range.model_dump(mode='json')
        return JSONResponse(status_code=error.status, content=content)


@app.post('/api/research', response_model=ResearchResult, responses={
    429: {'model': ResearchResult, 'description': 'Research request already active'},
    503: {'model': ResearchResult, 'description': 'Research unavailable'},
})
async def research(body: ResearchInput, request: Request):
    status, result = await request.app.state.research.run(request.app.state.market_data, body)
    return JSONResponse(status_code=status, content=result.model_dump(mode='json'))


@app.post('/api/research/agent', response_model=AgentResult, responses={
    429: {'model': AgentResult, 'description': 'Research request already active'},
    503: {'model': AgentResult, 'description': 'Research unavailable'},
})
async def research_agent(body: AgentInput, request: Request):
    agent = request.app.state.research_agent
    result = AgentResult(question=body.question, explanation=research_outcome('research_unavailable'))
    if agent.model is None:
        return JSONResponse(status_code=503, content=result.model_dump(mode='json'))
    # Share admission with /api/research; never queue or acquire its lock twice.
    active = request.app.state.research.active
    if not active.acquire(blocking=False):
        result.explanation = research_outcome('research_busy')
        return JSONResponse(status_code=429, content=result.model_dump(mode='json'))
    try:
        return await agent.run(request.app.state.market_data, body)
    finally:
        active.release()
