from fastapi import FastAPI

app = FastAPI(title="MarketSim API")


@app.get("/health")
def get_health() -> dict[str, str]:
    """Confirm the API responds, without checking external services."""
    return {"status": "ok", "service": "marketsim-api"}
