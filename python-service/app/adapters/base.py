"""Contrato comun de los adaptadores de fabricante.

El sistema define esta interfaz para poder incorporar otros fabricantes en el
futuro, pero en esta version SOLO se implementa `HuaweiSmartPVMSAdapter`.
No se implementa ningun mecanismo no autorizado (scraping, ingenieria inversa
de aplicaciones moviles, etc.): unicamente APIs oficiales con credenciales.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

Granularidad = Literal["DIARIA", "MENSUAL"]


class ErrorAdaptador(Exception):
    """Error de negocio del adaptador, con codigo estable para el backend."""

    def __init__(self, codigo: str, mensaje: str, detalle: dict | None = None) -> None:
        super().__init__(mensaje)
        self.codigo = codigo
        self.mensaje = mensaje
        self.detalle = detalle or {}


@dataclass
class ConfiguracionAdaptador:
    modo: Literal["MOCK", "REAL"]
    endpoint: str
    timeout_s: int = 40
    max_reintentos: int = 3
    ip_autorizada: str | None = None
    usuario_api: str | None = None


@dataclass
class RegistroCanonico:
    """Formato canonico unico que consume el backend Node.js."""

    serial: str
    fecha: str  # ISO 8601 (YYYY-MM-DD)
    kwh: float
    granularidad: Granularidad
    estacion: str | None = None

    def a_dict(self) -> dict:
        return {
            "serial": self.serial,
            "fecha": self.fecha,
            "kwh": round(float(self.kwh), 4),
            "granularidad": self.granularidad,
            "estacion": self.estacion,
        }


@dataclass
class ResultadoProduccion:
    registros: list[RegistroCanonico] = field(default_factory=list)
    advertencias: list[str] = field(default_factory=list)
    # serial (minusculas) -> codigo de estacion descubierto en el fabricante.
    estaciones_resueltas: dict[str, str] = field(default_factory=dict)


class AdaptadorFabricante(ABC):
    """Interfaz que debe cumplir todo adaptador de fabricante."""

    marca: str = "GENERICO"

    def __init__(self, config: ConfiguracionAdaptador) -> None:
        self.config = config

    @abstractmethod
    async def probar_conexion(self) -> dict:
        """Verifica credenciales y alcance de red. No transfiere produccion."""

    @abstractmethod
    async def obtener_produccion(
        self,
        seriales: list[str],
        estaciones: list[str],
        desde: date,
        hasta: date,
        granularidad: Granularidad,
    ) -> ResultadoProduccion:
        """Devuelve la produccion normalizada al formato canonico."""
