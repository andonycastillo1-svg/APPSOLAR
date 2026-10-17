"""Configuracion del servicio de integracion.

Este servicio es INTERNO: solo debe escuchar en la red privada del servidor
y jamas exponerse directamente a Internet. El backend Node.js es el unico
punto publico de la logica de aplicacion.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

RAIZ = Path(__file__).resolve().parents[2]

for archivo in (RAIZ / ".env", RAIZ / "python-service" / ".env"):
    if archivo.exists():
        load_dotenv(archivo, override=False)


def _texto(clave: str, por_defecto: str = "") -> str:
    valor = os.getenv(clave)
    return valor if valor not in (None, "") else por_defecto


def _entero(clave: str, por_defecto: int) -> int:
    try:
        return int(_texto(clave, str(por_defecto)))
    except ValueError:
        return por_defecto


class Configuracion:
    """Valores de entorno del adaptador."""

    version = "1.0.0"

    host = _texto("PYTHON_SERVICE_HOST", "127.0.0.1")
    puerto = _entero("PYTHON_SERVICE_PORT", 8000)

    # Token compartido con el backend Node.js. Sin el, ninguna peticion se atiende.
    token_servicio = _texto("PYTHON_SERVICE_TOKEN", "token-interno-desarrollo")

    # Modo global por defecto: mock | real
    modo = "REAL" if _texto("HUAWEI_MODE", "mock").lower() == "real" else "MOCK"

    base_url = _texto("HUAWEI_BASE_URL", "https://intl.fusionsolar.huawei.com/thirdData")
    usuario = _texto("HUAWEI_USERNAME")
    system_code = _texto("HUAWEI_SYSTEM_CODE")
    timeout_s = _entero("HUAWEI_TIMEOUT_S", 40)
    max_reintentos = _entero("HUAWEI_MAX_RETRIES", 3)
    ip_autorizada = _texto("HUAWEI_AUTHORIZED_IP")

    # Semilla del generador simulado: hace reproducibles los datos de prueba.
    semilla_mock = _entero("HUAWEI_MOCK_SEED", 20260821)

    nivel_log = _texto("LOG_LEVEL", "info")


configuracion = Configuracion()
