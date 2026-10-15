import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from app.market_data import MarketData, Quote, QuoteError


@asynccontextmanager
async def lifespan(app: FastAPI):
    # HTTPX INFO logs include request URLs; suppress transport logs containing keys.
    for name in ('httpx', 'httpcore'):
        logging.getLogger(name).disabled = True
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=False,
                                 trust_env=False, limits=httpx.Limits(max_connections=3)) as client:
        service = MarketData(client)
        app.state.market_data = service
        try:
            yield
        finally:
            await service.close()


app = FastAPI(title='MarketSim API', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
    allow_methods=['GET'],
    allow_credentials=False,
)


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
