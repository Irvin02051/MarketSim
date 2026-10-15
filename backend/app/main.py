import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.gemini_client import configured_client
from app.market_data import MarketData, Quote, QuoteError
from app.research_explanation import ResearchExplanation, ResearchInput, ResearchResult


@asynccontextmanager
async def lifespan(app: FastAPI):
    # HTTPX INFO logs include request URLs; suppress transport logs containing keys.
    for name in ('httpx', 'httpcore', 'google.genai', 'google.genai._api_client', 'google.genai.models'):
        logging.getLogger(name).disabled = True
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=False,
                                 trust_env=False, limits=httpx.Limits(max_connections=3)) as client:
        service = MarketData(client)
        app.state.market_data = service
        model = configured_client()
        app.state.research = ResearchExplanation(model)
        try:
            yield
        finally:
            try:
                if model is not None:
                    await model.close()
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


@app.post('/api/research', response_model=ResearchResult, responses={
    429: {'model': ResearchResult, 'description': 'Research request already active'},
    503: {'model': ResearchResult, 'description': 'Research unavailable'},
})
async def research(body: ResearchInput, request: Request):
    status, result = await request.app.state.research.run(request.app.state.market_data, body)
    return JSONResponse(status_code=status, content=result.model_dump(mode='json'))
