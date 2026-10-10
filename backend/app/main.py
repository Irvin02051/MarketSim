from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="MarketSim API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_credentials=False,
)


@app.get("/health")
def get_health() -> dict[str, str]:
    """Confirm the API responds, without checking external services."""
    return {"status": "ok", "service": "marketsim-api"}
