import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.gemini_client import configured_client
from app.market_data import MarketData, Quote, QuoteError
from app.research_agent import AgentInput, AgentResult, ResearchAgent
from app.research_explanation import ResearchExplanation, ResearchInput, ResearchResult
from app.research_explanation import explanation as research_outcome


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
        app.state.research_agent = ResearchAgent(model)
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
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
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
