"""Adaptador Huawei SmartPVMS (FusionSolar Northbound API).

Dos modos:

* ``MOCK``  -> genera datos SIMULADOS deterministas. Se usa cuando aun no hay
  credenciales del fabricante. Toda respuesta viene marcada como simulada
  para que el backend y la interfaz puedan advertirlo y nunca se mezcle con
  datos reales sin confirmacion.

* ``REAL``  -> consume la API oficial autorizada:
      POST /thirdData/login                 (autenticacion, devuelve XSRF-TOKEN)
      POST /thirdData/getStationList        (estaciones accesibles)
      POST /thirdData/getDevList            (dispositivos de una estacion)
      POST /thirdData/getDevKpiDay          (produccion diaria por dispositivo)
      POST /thirdData/getKpiStationMonth    (produccion mensual por estacion)

  Requiere ``HUAWEI_USERNAME`` y ``HUAWEI_SYSTEM_CODE`` en el entorno (una
  cuenta Northbound creada por un Administrador de la Empresa en el portal
  FusionSolar, distinta del login normal).

  Sobre la restriccion de IP: las guias de alta de cuenta Northbound
  vigentes no piden registrar una IP publica como paso obligatorio, asi que
  no se debe asumir que hace falta gestionarla de antemano. Sin embargo el
  codigo 20008 (IP_NO_AUTORIZADA, mas abajo) existe en el protocolo, por lo
  que algunas cuentas si podrian tenerla restringida. Si REAL falla con ese
  codigo, es la senal de pedirle al administrador de FusionSolar que
  autorice la IP publica del servidor donde corre este servicio.
"""

from __future__ import annotations

import asyncio
import math
import random
from datetime import date, datetime, timedelta, timezone

import httpx

from ..config import configuracion
from .base import (
    AdaptadorFabricante,
    ConfiguracionAdaptador,
    ErrorAdaptador,
    Granularidad,
    RegistroCanonico,
    ResultadoProduccion,
)

# Codigos de fallo documentados por la API northbound de Huawei.
CODIGOS_HUAWEI = {
    20001: ("CREDENCIALES_INVALIDAS", "Usuario o systemCode invalidos."),
    20002: ("CREDENCIALES_INVALIDAS", "La cuenta no tiene permisos northbound."),
    20005: ("LIMITE_API", "Se alcanzo el limite de peticiones por intervalo."),
    20006: ("LIMITE_API", "Se alcanzo el limite de peticiones por intervalo."),
    20007: ("CREDENCIALES_INVALIDAS", "La sesion expiro; vuelva a autenticar."),
    20008: ("IP_NO_AUTORIZADA", "La IP de origen no esta autorizada."),
    305: ("CREDENCIALES_INVALIDAS", "No autenticado ante SmartPVMS."),
    401: ("CREDENCIALES_INVALIDAS", "Credenciales rechazadas por SmartPVMS."),
    407: ("LIMITE_API", "Frecuencia de consulta excedida."),
    20618: ("LIMITE_API", "Se alcanzo el limite diario de llamadas permitidas por usuario."),
}

# Perfil de irradiacion mensual usado por el generador simulado (Guatemala).
ESTACIONALIDAD = [1.02, 1.06, 1.12, 1.05, 0.92, 0.82, 0.88, 0.90, 0.85, 0.90, 0.98, 1.00]


class HuaweiSmartPVMSAdapter(AdaptadorFabricante):
    marca = "HUAWEI"

    def __init__(self, config: ConfiguracionAdaptador) -> None:
        super().__init__(config)
        self._token: str | None = None
        self._cookies: httpx.Cookies | None = None

    # ------------------------------------------------------------------
    # Utilidades
    # ------------------------------------------------------------------

    @property
    def es_simulado(self) -> bool:
        return self.config.modo == "MOCK"

    def _exigir_credenciales(self) -> None:
        if not configuracion.usuario or not configuracion.system_code:
            raise ErrorAdaptador(
                "CONFIGURACION_INCOMPLETA",
                "Faltan HUAWEI_USERNAME o HUAWEI_SYSTEM_CODE en el entorno del servicio Python.",
            )

    @staticmethod
    def _traducir(codigo: int | str | None, mensaje: str | None) -> ErrorAdaptador:
        try:
            numerico = int(codigo)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            numerico = -1
        traduccion = CODIGOS_HUAWEI.get(numerico)
        if traduccion:
            return ErrorAdaptador(traduccion[0], traduccion[1], {"codigoFabricante": codigo})
        return ErrorAdaptador(
            "FORMATO_INESPERADO",
            mensaje or "SmartPVMS devolvio un codigo de fallo no documentado.",
            {"codigoFabricante": codigo},
        )

    # ------------------------------------------------------------------
    # Modo REAL
    # ------------------------------------------------------------------

    async def _cliente(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.config.endpoint.rstrip("/"),
            timeout=httpx.Timeout(self.config.timeout_s),
            headers={"Content-Type": "application/json"},
        )

    async def _autenticar(self, cliente: httpx.AsyncClient) -> str:
        self._exigir_credenciales()
        try:
            respuesta = await cliente.post(
                "/login",
                json={
                    "userName": configuracion.usuario,
                    "systemCode": configuracion.system_code,
                },
            )
        except httpx.TimeoutException as error:
            raise ErrorAdaptador("TIEMPO_AGOTADO", "Tiempo de espera agotado al autenticar.") from error
        except httpx.HTTPError as error:
            raise ErrorAdaptador(
                "SERVICIO_NO_DISPONIBLE",
                "No fue posible alcanzar el servidor de SmartPVMS.",
                {"detalle": str(error)},
            ) from error

        if respuesta.status_code == 403:
            raise ErrorAdaptador(
                "IP_NO_AUTORIZADA",
                "SmartPVMS rechazo la conexion: la IP de origen no esta autorizada.",
            )

        try:
            cuerpo = respuesta.json()
        except ValueError as error:
            raise ErrorAdaptador("FORMATO_INESPERADO", "La respuesta de login no es JSON.") from error

        if not cuerpo.get("success"):
            raise self._traducir(cuerpo.get("failCode"), cuerpo.get("message"))

        token = respuesta.headers.get("xsrf-token") or respuesta.headers.get("XSRF-TOKEN")
        if not token:
            raise ErrorAdaptador(
                "FORMATO_INESPERADO",
                "SmartPVMS no devolvio el token de sesion (XSRF-TOKEN).",
            )

        self._token = token
        return token

    async def _peticion(
        self,
        cliente: httpx.AsyncClient,
        ruta: str,
        carga: dict,
    ) -> dict:
        """POST autenticado con reintentos y retroceso exponencial."""
        if not self._token:
            await self._autenticar(cliente)

        ultimo_error: ErrorAdaptador | None = None

        for intento in range(self.config.max_reintentos + 1):
            try:
                respuesta = await cliente.post(
                    ruta,
                    json=carga,
                    headers={"XSRF-TOKEN": self._token or ""},
                )
            except httpx.TimeoutException:
                ultimo_error = ErrorAdaptador(
                    "TIEMPO_AGOTADO", f"Tiempo de espera agotado consultando {ruta}."
                )
                await asyncio.sleep(min(2**intento, 8))
                continue
            except httpx.HTTPError as error:
                ultimo_error = ErrorAdaptador(
                    "SERVICIO_NO_DISPONIBLE",
                    "No fue posible alcanzar SmartPVMS.",
                    {"detalle": str(error)},
                )
                await asyncio.sleep(min(2**intento, 8))
                continue

            if respuesta.status_code == 403:
                raise ErrorAdaptador(
                    "IP_NO_AUTORIZADA",
                    "SmartPVMS rechazo la peticion: IP de origen no autorizada.",
                )

            try:
                cuerpo = respuesta.json()
            except ValueError as error:
                raise ErrorAdaptador(
                    "FORMATO_INESPERADO", f"La respuesta de {ruta} no es JSON valido."
                ) from error

            if cuerpo.get("success"):
                return cuerpo

            error_traducido = self._traducir(cuerpo.get("failCode"), cuerpo.get("message"))

            # La sesion expirada se reintenta una vez tras reautenticar.
            if error_traducido.codigo == "CREDENCIALES_INVALIDAS" and intento == 0:
                self._token = None
                await self._autenticar(cliente)
                continue

            # El limite de frecuencia admite retroceso exponencial.
            if error_traducido.codigo == "LIMITE_API" and intento < self.config.max_reintentos:
                ultimo_error = error_traducido
                await asyncio.sleep(min(2**intento, 8) + 1)
                continue

            raise error_traducido

        raise ultimo_error or ErrorAdaptador("SERVICIO_NO_DISPONIBLE", "Sin respuesta de SmartPVMS.")

    async def _produccion_real(
        self,
        seriales: list[str],
        estaciones: list[str],
        desde: date,
        hasta: date,
        granularidad: Granularidad,
    ) -> ResultadoProduccion:
        resultado = ResultadoProduccion()

        async with await self._cliente() as cliente:
            await self._autenticar(cliente)

            # Mapa serial -> devId consultando los dispositivos de cada estacion.
            mapa_dispositivos: dict[str, str] = {}
            # devTypeId: 1 = inversor string, 38 = inversor residencial. El KPI
            # solo responde si el tipo enviado coincide con el del dispositivo.
            tipo_por_id: dict[str, int] = {}

            async def cargar_dispositivos(codigos: list[str]) -> None:
                # getDevList admite hasta 100 estaciones por llamada.
                for inicio in range(0, len(codigos), 100):
                    lote = codigos[inicio : inicio + 100]
                    cuerpo = await self._peticion(
                        cliente, "/getDevList", {"stationCodes": ",".join(lote)}
                    )
                    for dispositivo in cuerpo.get("data") or []:
                        sn = str(dispositivo.get("esnCode") or dispositivo.get("devDn") or "")
                        if not sn:
                            continue
                        dev_id = str(dispositivo.get("id"))
                        mapa_dispositivos[sn.lower()] = dev_id
                        tipo_por_id[dev_id] = int(dispositivo.get("devTypeId") or 1)
                        codigo_estacion = dispositivo.get("stationCode")
                        if codigo_estacion:
                            resultado.estaciones_resueltas[sn.lower()] = str(codigo_estacion)

            if estaciones:
                await cargar_dispositivos(list(estaciones))

            # Sin estacion declarada (o serial no hallado en ella): se descubre
            # recorriendo las estaciones de la cuenta. El resultado se devuelve
            # para que el backend lo guarde y la proxima vez baste una llamada.
            if any(s.lower() not in mapa_dispositivos for s in seriales):
                lista = await self._peticion(cliente, "/getStationList", {})
                codigos = [
                    str(e.get("stationCode"))
                    for e in (lista.get("data") or [])
                    if e.get("stationCode") and str(e.get("stationCode")) not in set(estaciones or [])
                ]
                await cargar_dispositivos(codigos)

            # Solo se devuelven las estaciones de los seriales pedidos.
            pedidos = {s.lower() for s in seriales}
            resultado.estaciones_resueltas = {
                k: v for k, v in resultado.estaciones_resueltas.items() if k in pedidos
            }

            faltantes = [s for s in seriales if s.lower() not in mapa_dispositivos]
            if faltantes:
                resultado.advertencias.append(
                    "SmartPVMS no reporto estos dispositivos: " + ", ".join(faltantes)
                )

            ids = [mapa_dispositivos[s.lower()] for s in seriales if s.lower() in mapa_dispositivos]
            if not ids:
                return resultado

            inverso = {v: k for k, v in mapa_dispositivos.items()}
            # Huawei devuelve el MES completo en getDevKpiDay y el AÑO completo en
            # getDevKpiMonth: se consulta una vez por periodo, no una vez por dia.
            inicio_rango = desde if granularidad == "DIARIA" else desde.replace(day=1)
            actual = desde.replace(day=1) if granularidad == "DIARIA" else desde.replace(month=1, day=1)
            vistos: set[tuple[str, str]] = set()

            while actual <= hasta:
                # Se consulta a mitad del periodo: Huawei interpreta la hora en la zona
                # de la planta, y a medianoche UTC caeria en el periodo anterior.
                referencia = (
                    datetime(actual.year, actual.month, 15, 12, tzinfo=timezone.utc)
                    if granularidad == "DIARIA"
                    else datetime(actual.year, 7, 1, 12, tzinfo=timezone.utc)
                )
                marca_tiempo = int(referencia.timestamp() * 1000)
                ruta = "/getDevKpiDay" if granularidad == "DIARIA" else "/getDevKpiMonth"
                filas_kpi: list[dict] = []
                for tipo in sorted({tipo_por_id.get(i, 1) for i in ids}):
                    ids_tipo = [i for i in ids if tipo_por_id.get(i, 1) == tipo]
                    cuerpo = await self._peticion(
                        cliente,
                        ruta,
                        {"devIds": ",".join(ids_tipo), "devTypeId": tipo, "collectTime": marca_tiempo},
                    )
                    filas_kpi.extend(cuerpo.get("data") or [])

                for fila in filas_kpi:
                    dev_id = str(fila.get("devId"))
                    indicadores = fila.get("dataItemMap") or {}
                    energia = indicadores.get("product_power")
                    if energia is None:
                        continue
                    serial = inverso.get(dev_id, dev_id)
                    marca = fila.get("collectTime", marca_tiempo)
                    fecha_registro = datetime.fromtimestamp(marca / 1000, tz=timezone.utc).date()
                    if not (inicio_rango <= fecha_registro <= hasta):
                        continue
                    clave = (serial, fecha_registro.isoformat())
                    if clave in vistos:
                        continue
                    vistos.add(clave)
                    resultado.registros.append(
                        RegistroCanonico(
                            serial=serial,
                            fecha=fecha_registro.isoformat(),
                            kwh=float(energia),
                            granularidad=granularidad,
                        )
                    )

                if granularidad == "DIARIA":
                    actual = date(actual.year + (actual.month == 12), (actual.month % 12) + 1, 1)
                else:
                    actual = date(actual.year + 1, 1, 1)

        return resultado

    # ------------------------------------------------------------------
    # Modo MOCK (sandbox)
    # ------------------------------------------------------------------

    def _produccion_simulada(
        self,
        seriales: list[str],
        estaciones: list[str],
        desde: date,
        hasta: date,
        granularidad: Granularidad,
    ) -> ResultadoProduccion:
        resultado = ResultadoProduccion(
            advertencias=[
                "DATOS SIMULADOS: generados por el modo sandbox del adaptador. "
                "No provienen de la plataforma real del fabricante."
            ]
        )

        estacion = estaciones[0] if estaciones else None

        for indice, serial in enumerate(seriales):
            # Semilla estable por serial: dos ejecuciones devuelven lo mismo,
            # lo que permite comprobar la idempotencia de la sincronizacion.
            generador = random.Random(f"{configuracion.semilla_mock}-{serial}")
            capacidad = 250 + (indice % 3) * 125  # kWp ficticios

            actual = desde
            while actual <= hasta:
                factor = ESTACIONALIDAD[actual.month - 1]
                if granularidad == "DIARIA":
                    # Rendimiento diario tipico: 3.5 a 5.5 kWh/kWp segun estacion.
                    base = capacidad * (4.4 * factor)
                    ruido = generador.uniform(0.82, 1.12)
                    # Los domingos de mantenimiento reducen la generacion.
                    if actual.weekday() == 6 and generador.random() < 0.12:
                        ruido *= 0.45
                    kwh = max(0.0, base * ruido)
                    siguiente = actual + timedelta(days=1)
                else:
                    dias = (
                        (date(actual.year + (actual.month == 12), (actual.month % 12) + 1, 1)
                         - date(actual.year, actual.month, 1)).days
                    )
                    kwh = max(0.0, capacidad * 4.4 * factor * dias * generador.uniform(0.9, 1.08))
                    siguiente = date(actual.year + (actual.month == 12), (actual.month % 12) + 1, 1)

                resultado.registros.append(
                    RegistroCanonico(
                        serial=serial,
                        fecha=(actual if granularidad == "DIARIA" else actual.replace(day=1)).isoformat(),
                        kwh=round(kwh, 4),
                        granularidad=granularidad,
                        estacion=estacion,
                    )
                )
                actual = siguiente

        return resultado

    # ------------------------------------------------------------------
    # Interfaz publica
    # ------------------------------------------------------------------

    async def probar_conexion(self) -> dict:
        if self.es_simulado:
            return {
                "ok": True,
                "modo": "MOCK",
                "mensaje": (
                    "Conexion simulada correcta. El adaptador esta en modo sandbox: "
                    "no se contacto la plataforma real del fabricante."
                ),
                "ip_saliente": None,
                "detalle": {
                    "endpoint": self.config.endpoint,
                    "credencialesConfiguradas": bool(configuracion.usuario and configuracion.system_code),
                    "ipAutorizadaDeclarada": self.config.ip_autorizada or configuracion.ip_autorizada or None,
                },
            }

        self._exigir_credenciales()

        ip_saliente = None
        try:
            async with httpx.AsyncClient(timeout=6) as sonda:
                respuesta = await sonda.get("https://api.ipify.org?format=json")
                if respuesta.status_code == 200:
                    ip_saliente = respuesta.json().get("ip")
        except httpx.HTTPError:
            ip_saliente = None

        esperada = self.config.ip_autorizada or configuracion.ip_autorizada
        if esperada and ip_saliente and esperada != ip_saliente:
            raise ErrorAdaptador(
                "IP_NO_AUTORIZADA",
                (
                    f"La IP publica de salida ({ip_saliente}) no coincide con la autorizada "
                    f"({esperada}). Actualice el registro ante Huawei antes de sincronizar."
                ),
                {"ipSaliente": ip_saliente, "ipAutorizada": esperada},
            )

        async with await self._cliente() as cliente:
            await self._autenticar(cliente)
            cuerpo = await self._peticion(cliente, "/getStationList", {})

        estaciones = cuerpo.get("data") or []
        return {
            "ok": True,
            "modo": "REAL",
            "mensaje": f"Conexion establecida con SmartPVMS. Estaciones accesibles: {len(estaciones)}.",
            "ip_saliente": ip_saliente,
            "detalle": {
                "estaciones": [
                    {"codigo": e.get("stationCode"), "nombre": e.get("stationName")}
                    for e in estaciones[:20]
                ]
            },
        }

    async def obtener_produccion(
        self,
        seriales: list[str],
        estaciones: list[str],
        desde: date,
        hasta: date,
        granularidad: Granularidad,
    ) -> ResultadoProduccion:
        if desde > hasta:
            raise ErrorAdaptador(
                "FORMATO_INESPERADO", "La fecha inicial no puede ser posterior a la final."
            )

        dias = (hasta - desde).days
        # Cada consulta a Huawei cubre un mes (diario) o un año (mensual), asi que
        # el costo en llamadas es bajo; el tope solo evita rangos desmedidos.
        maximo_dias = 800 if granularidad == "DIARIA" else 3700
        if dias > maximo_dias:
            raise ErrorAdaptador(
                "LIMITE_API",
                f"El rango solicitado supera los {maximo_dias} dias para esta granularidad. "
                "Divida la consulta en periodos menores.",
            )

        if self.es_simulado:
            return self._produccion_simulada(seriales, estaciones, desde, hasta, granularidad)

        return await self._produccion_real(seriales, estaciones, desde, hasta, granularidad)


def crear_adaptador(config: ConfiguracionAdaptador) -> HuaweiSmartPVMSAdapter:
    """Fabrica del unico adaptador implementado en esta version."""
    return HuaweiSmartPVMSAdapter(config)


__all__ = ["HuaweiSmartPVMSAdapter", "crear_adaptador", "math"]
