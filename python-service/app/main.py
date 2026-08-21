"""Servicio interno de integracion y ETL especializado.

Responsabilidades:
  * Autenticar y consultar la API autorizada de Huawei SmartPVMS.
  * Transformar la respuesta del fabricante al formato canonico del sistema.
  * Ofrecer un modo simulado (sandbox) claramente identificado.

Este servicio NO se expone a Internet y NO accede a MySQL: toda persistencia y
autorizacion de negocio ocurre en el backend Node.js.
"""

from __future__ import annotations

import logging
import time
from datetime import date

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from .adapters.base import ConfiguracionAdaptador, ErrorAdaptador
from .adapters.huawei import crear_adaptador
from .config import configuracion

logging.basicConfig(
    level=getattr(logging, configuracion.nivel_log.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
registro = logging.getLogger("integracion-huawei")

app = FastAPI(
    title="Servicio de integracion Huawei SmartPVMS",
    description=(
        "Adaptador interno del Sistema Centralizado de Monitoreo Energetico de Retse, S.A. "
        "Uso exclusivo del backend Node.js."
    ),
    version=configuracion.version,
    docs_url="/docs",
)


# ---------------------------------------------------------------------------
# Contratos
# ---------------------------------------------------------------------------


class ConfigEntrada(BaseModel):
    modo: str = "MOCK"
    endpoint: str = configuracion.base_url
    ip_autorizada: str | None = None
    usuario_api: str | None = None
    timeout_s: int = Field(default=40, ge=5, le=300)
    max_reintentos: int = Field(default=3, ge=0, le=10)

    @field_validator("modo")
    @classmethod
    def _modo_valido(cls, valor: str) -> str:
        normalizado = (valor or "MOCK").upper()
        return "REAL" if normalizado == "REAL" else "MOCK"

    def a_dataclass(self) -> ConfiguracionAdaptador:
        return ConfiguracionAdaptador(
            modo=self.modo,  # type: ignore[arg-type]
            endpoint=self.endpoint,
            timeout_s=self.timeout_s,
            max_reintentos=self.max_reintentos,
            ip_autorizada=self.ip_autorizada,
            usuario_api=self.usuario_api,
        )


class PeticionPrueba(BaseModel):
    config: ConfigEntrada


class PeticionProduccion(BaseModel):
    config: ConfigEntrada
    seriales: list[str] = Field(default_factory=list, max_length=500)
    estaciones: list[str] = Field(default_factory=list, max_length=200)
    desde: date
    hasta: date
    granularidad: str = "DIARIA"

    @field_validator("granularidad")
    @classmethod
    def _granularidad_valida(cls, valor: str) -> str:
        normalizado = (valor or "DIARIA").upper()
        if normalizado not in ("DIARIA", "MENSUAL"):
            raise ValueError("La granularidad debe ser DIARIA o MENSUAL.")
        return normalizado


# ---------------------------------------------------------------------------
# Seguridad del canal interno
# ---------------------------------------------------------------------------


def _verificar_token(token: str | None) -> None:
    if not token or token != configuracion.token_servicio:
        raise ErrorAdaptador(
            "NO_AUTORIZADO",
            "Token de servicio invalido. Este servicio es interno y no acepta llamadas externas.",
        )


@app.exception_handler(ErrorAdaptador)
async def manejar_error_adaptador(_: Request, error: ErrorAdaptador) -> JSONResponse:
    estados = {
        "NO_AUTORIZADO": 401,
        "CREDENCIALES_INVALIDAS": 401,
        "IP_NO_AUTORIZADA": 403,
        "LIMITE_API": 429,
        "TIEMPO_AGOTADO": 504,
        "FORMATO_INESPERADO": 502,
        "SERVICIO_NO_DISPONIBLE": 503,
        "CONFIGURACION_INCOMPLETA": 422,
    }
    registro.warning("Error del adaptador [%s]: %s", error.codigo, error.mensaje)
    return JSONResponse(
        status_code=estados.get(error.codigo, 502),
        content={"ok": False, "codigo": error.codigo, "mensaje": error.mensaje, "detalle": error.detalle},
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def salud(x_service_token: str | None = Header(default=None)) -> dict:
    _verificar_token(x_service_token)
    return {
        "ok": True,
        "version": configuracion.version,
        "modo": configuracion.modo,
        "credencialesConfiguradas": bool(configuracion.usuario and configuracion.system_code),
    }


@app.post("/huawei/test")
async def probar(
    peticion: PeticionPrueba,
    x_service_token: str | None = Header(default=None),
) -> dict:
    _verificar_token(x_service_token)
    adaptador = crear_adaptador(peticion.config.a_dataclass())
    return await adaptador.probar_conexion()


@app.post("/huawei/production")
async def produccion(
    peticion: PeticionProduccion,
    x_service_token: str | None = Header(default=None),
) -> dict:
    _verificar_token(x_service_token)

    inicio = time.time()
    adaptador = crear_adaptador(peticion.config.a_dataclass())

    resultado = await adaptador.obtener_produccion(
        seriales=peticion.seriales,
        estaciones=peticion.estaciones,
        desde=peticion.desde,
        hasta=peticion.hasta,
        granularidad=peticion.granularidad,  # type: ignore[arg-type]
    )

    duracion = int((time.time() - inicio) * 1000)
    registro.info(
        "Produccion %s: %d registro(s) para %d serial(es) en %d ms",
        peticion.config.modo,
        len(resultado.registros),
        len(peticion.seriales),
        duracion,
    )

    return {
        "ok": True,
        "modo": peticion.config.modo,
        "registros": [r.a_dict() for r in resultado.registros],
        "advertencias": resultado.advertencias,
        "duracion_ms": duracion,
        "rango": {"desde": peticion.desde.isoformat(), "hasta": peticion.hasta.isoformat()},
    }


def ejecutar() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=configuracion.host,
        port=configuracion.puerto,
        log_level=configuracion.nivel_log,
    )


if __name__ == "__main__":
    ejecutar()
