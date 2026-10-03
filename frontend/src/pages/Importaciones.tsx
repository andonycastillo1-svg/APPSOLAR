import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, descargar, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import {
  Cargando,
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
} from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { anioActual, claseEstado, fecha, fechaHora, kwh, nombreMes, numero, textoEstado } from '../lib/formato';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Historico {
  id_historico: number;
  proyecto: string | null;
  formato: string;
  nivel_detalle: string;
  nombre_archivo_original: string;
  hash_sha256: string;
  estado: string;
  total_filas: number;
  insertadas: number;
  actualizadas: number;
  duplicadas: number;
  rechazadas: number;
  advertencias: number;
  fecha_min: string | null;
  fecha_max: string | null;
  usuario: string | null;
  mensaje: string | null;
  created_at: string;
  confirmado_en: string | null;
}

interface Problema {
  fila: number;
  columna: string | null;
  valor: string | null;
  codigo: string;
  severidad: 'ERROR' | 'ADVERTENCIA';
  mensaje: string;
}

interface Grupo {
  clave: string;
  planta: string;
  anio: number;
  mes: number;
  mesNombre: string;
  filas: number;
  kwhTotal: number;
  tieneSerial: boolean;
  requiereDecision: boolean;
  numerosFila: number[];
  idProyectoResuelto: number | null;
}

interface Previsualizacion {
  id_historico: number;
  formato: string;
  nivelDetalleLote: string;
  encabezados: string[];
  mapeoDetectado: Record<string, string>;
  totales: { filasLeidas: number; validas: number; errores: number; advertencias: number; duplicados: number };
  muestra: Array<{
    fila: number;
    planta: string | null;
    tipo: string | null;
    anio: number;
    mes: number;
    fecha: string;
    kwh: number;
    serial: string | null;
    comentarios: string | null;
  }>;
  grupos: Grupo[];
  gruposQueRequierenDecision: Array<Grupo & { opciones: Array<{ valor: string; descripcion: string }> }>;
  plantasNoResueltas: string[];
  serialesNoResueltos: string[];
  duplicados: Array<{ fila: number; motivo: string }>;
  conflictosNivelDetalle: Array<{ proyecto: string; anio: number; mes: number; existente: string; entrante: string }>;
  periodosCerrados: Array<{ proyecto: string; anio: number; mes: number }>;
  mesesSinTarifaAprobada: Array<{ proyecto: string; anio: number; mes: number; mesNombre: string }>;
  problemas: Problema[];
  puedeConfirmar: boolean;
  requiereConfirmarCargaParcial: boolean;
  filasQueSeDescartaran: number;
  mensaje: string;
}

interface ResultadoConfirmacion {
  id_historico: number;
  estado: string;
  insertadas: number;
  actualizadas: number;
  omitidas: number;
  rechazadas: number;
  pendientesTarifa: number;
  mensaje: string;
}

const PASOS = [
  'Seleccionar destino',
  'Descargar plantilla',
  'Elegir archivo',
  'Validar y previsualizar',
  'Resolver decisiones',
  'Confirmar carga',
  'Resumen final',
];

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

export function PaginaImportaciones() {
  const { puede } = useSesion();
  const [asistenteAbierto, setAsistenteAbierto] = useState(false);
  const [detalle, setDetalle] = useState<number | null>(null);

  const listado = useListado<Historico>('importaciones', '/imports', {});

  const consultaDetalle = useQuery({
    queryKey: ['importacion', detalle],
    enabled: detalle !== null,
    queryFn: async () =>
      (await api.obtener<Historico & { errores: Problema[] }>(`/imports/${detalle}`)).datos,
  });

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Carga de historicos</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Asistente por pasos con validacion, previsualizacion y confirmacion. Admite la plantilla
            normalizada y el formato historico del Excel existente.
          </p>
        </div>
        {puede('importaciones.cargar') ? (
          <button type="button" className="boton" onClick={() => setAsistenteAbierto(true)}>
            Nueva importacion
          </button>
        ) : null}
      </div>

      <section className="tarjeta">
        <div className="filtros no-imprimir">
          <CampoTexto
            etiqueta="Buscar por archivo"
            type="search"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Estado"
            value={String(listado.estado.estado ?? '')}
            onChange={(e) => listado.actualizar({ estado: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="VALIDADO">Validado (pendiente de confirmar)</option>
            <option value="COMPLETADO">Completado</option>
            <option value="COMPLETADO_CON_ERRORES">Completado con errores</option>
            <option value="FALLIDO">Fallido</option>
            <option value="RECHAZADO">Cancelado</option>
            <option value="EXPIRADO">Expirado</option>
          </CampoSelect>
        </div>

        <Tabla<Historico>
          titulo="Historial de importaciones"
          descripcion="Cada lote conserva su archivo, hash, usuario, periodo cubierto y resultado."
          columnas={[
            { clave: 'archivo', titulo: 'Archivo', render: (f) => f.nombre_archivo_original },
            { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto ?? 'Multiple' },
            { clave: 'formato', titulo: 'Formato', render: (f) => textoEstado(f.formato) },
            {
              clave: 'nivel',
              titulo: 'Nivel de detalle',
              render: (f) => <span className="etiqueta etiqueta--gris">{textoEstado(f.nivel_detalle)}</span>,
            },
            {
              clave: 'periodo',
              titulo: 'Periodo cubierto',
              render: (f) => (f.fecha_min ? `${fecha(f.fecha_min)} – ${fecha(f.fecha_max)}` : '—'),
            },
            {
              clave: 'resultado',
              titulo: 'Resultado',
              numerica: true,
              render: (f) => (
                <span>
                  {f.insertadas} nuevas / {f.actualizadas} act.
                  {f.rechazadas > 0 ? (
                    <span className="etiqueta etiqueta--rojo" style={{ marginLeft: '0.3rem' }}>
                      {f.rechazadas} rechazadas
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => <span className={claseEstado(f.estado)}>{textoEstado(f.estado)}</span>,
            },
            { clave: 'usuario', titulo: 'Usuario', render: (f) => f.usuario ?? '—' },
            { clave: 'fecha', titulo: 'Fecha', render: (f) => fechaHora(f.created_at) },
            {
              clave: 'acciones',
              titulo: 'Acciones',
              render: (f) => (
                <div className="acciones no-imprimir">
                  <button
                    type="button"
                    className="boton boton--secundario boton--pequeno"
                    onClick={() => setDetalle(f.id_historico)}
                  >
                    Detalle
                  </button>
                  {f.rechazadas > 0 || f.advertencias > 0 ? (
                    <button
                      type="button"
                      className="boton boton--secundario boton--pequeno"
                      onClick={() => void descargar(`/imports/${f.id_historico}/errors`)}
                    >
                      Errores CSV
                    </button>
                  ) : null}
                </div>
              ),
            },
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_historico}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          vacioTitulo="Aun no se ha realizado ninguna importacion"
          vacioDescripcion="Use el asistente para cargar el primer archivo historico."
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {asistenteAbierto ? (
        <Asistente
          alCerrar={() => {
            setAsistenteAbierto(false);
            listado.recargar();
          }}
        />
      ) : null}

      {detalle !== null ? (
        <Modal titulo="Detalle de la importacion" ancho alCerrar={() => setDetalle(null)}>
          {consultaDetalle.isLoading ? <Cargando /> : null}
          {consultaDetalle.error ? <MensajeError error={consultaDetalle.error} /> : null}
          {consultaDetalle.data ? (
            <>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem', fontSize: '0.87rem' }}>
                <dt style={{ fontWeight: 640 }}>Archivo</dt>
                <dd style={{ margin: 0 }}>{consultaDetalle.data.nombre_archivo_original}</dd>
                <dt style={{ fontWeight: 640 }}>Huella SHA-256</dt>
                <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.78rem', wordBreak: 'break-all' }}>
                  {consultaDetalle.data.hash_sha256}
                </dd>
                <dt style={{ fontWeight: 640 }}>Estado</dt>
                <dd style={{ margin: 0 }}>
                  <span className={claseEstado(consultaDetalle.data.estado)}>
                    {textoEstado(consultaDetalle.data.estado)}
                  </span>
                </dd>
                <dt style={{ fontWeight: 640 }}>Filas</dt>
                <dd style={{ margin: 0 }}>
                  {consultaDetalle.data.total_filas} leidas · {consultaDetalle.data.insertadas} insertadas ·{' '}
                  {consultaDetalle.data.actualizadas} actualizadas · {consultaDetalle.data.duplicadas} omitidas ·{' '}
                  {consultaDetalle.data.rechazadas} rechazadas
                </dd>
                <dt style={{ fontWeight: 640 }}>Usuario</dt>
                <dd style={{ margin: 0 }}>{consultaDetalle.data.usuario ?? '—'}</dd>
                <dt style={{ fontWeight: 640 }}>Confirmada</dt>
                <dd style={{ margin: 0 }}>{fechaHora(consultaDetalle.data.confirmado_en)}</dd>
                <dt style={{ fontWeight: 640 }}>Mensaje</dt>
                <dd style={{ margin: 0 }}>{consultaDetalle.data.mensaje ?? '—'}</dd>
              </dl>

              <h3 style={{ marginTop: '1.2rem' }}>Errores y advertencias</h3>
              <Tabla
                columnas={[
                  { clave: 'fila', titulo: 'Fila', numerica: true, render: (f) => f.fila ?? '—' },
                  { clave: 'columna', titulo: 'Columna', render: (f) => f.columna ?? '—' },
                  { clave: 'valor', titulo: 'Valor', render: (f) => f.valor ?? '—' },
                  {
                    clave: 'severidad',
                    titulo: 'Severidad',
                    render: (f) => (
                      <span className={f.severidad === 'ERROR' ? 'etiqueta etiqueta--rojo' : 'etiqueta etiqueta--ambar'}>
                        {f.severidad}
                      </span>
                    ),
                  },
                  { clave: 'mensaje', titulo: 'Mensaje', render: (f) => f.mensaje },
                ]}
                filas={consultaDetalle.data.errores}
                claveFila={(f) => `${f.fila}-${f.codigo}-${f.columna}`}
                vacioTitulo="La importacion no registro errores ni advertencias"
              />
            </>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Asistente por pasos
// ---------------------------------------------------------------------------

function Asistente({ alCerrar }: { alCerrar: () => void }) {
  const catalogos = useCatalogos();
  const [paso, setPaso] = useState(0);
  const [idProyecto, setIdProyecto] = useState('');
  const [idInversor, setIdInversor] = useState('');
  const [anioForzado, setAnioForzado] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<Previsualizacion | null>(null);
  const [resultado, setResultado] = useState<ResultadoConfirmacion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const [decisiones, setDecisiones] = useState<Record<string, string>>({});
  const [mapeoPlantas, setMapeoPlantas] = useState<Record<string, string>>({});
  const [politicaDuplicados, setPoliticaDuplicados] = useState<'ACTUALIZAR' | 'OMITIR'>('ACTUALIZAR');
  const [aceptarParcial, setAceptarParcial] = useState(false);
  const [confirmarMezcla, setConfirmarMezcla] = useState(false);

  const elegirArchivo = (evento: ChangeEvent<HTMLInputElement>) => {
    const seleccionado = evento.target.files?.[0] ?? null;
    setArchivo(seleccionado);
    setPrevia(null);
    setError(null);
  };

  const validar = async () => {
    if (!archivo) return;
    setOcupado(true);
    setError(null);
    try {
      const formulario = new FormData();
      formulario.append('archivo', archivo);
      if (idProyecto) formulario.append('id_proyecto', idProyecto);
      if (idInversor) formulario.append('id_inversor', idInversor);
      if (anioForzado) formulario.append('anio', anioForzado);

      const respuesta = await api.subir<Previsualizacion>('/imports/preview', formulario);
      setPrevia(respuesta.datos);
      setPaso(3);
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const confirmar = async () => {
    if (!previa) return;
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api.crear<ResultadoConfirmacion>(`/imports/${previa.id_historico}/confirm`, {
        politicaDuplicados,
        decisiones,
        mapeoPlantas: Object.fromEntries(
          Object.entries(mapeoPlantas)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, Number(v)]),
        ),
        aceptarCargaParcial: aceptarParcial,
        confirmarMezclaNiveles: confirmarMezcla,
      });
      setResultado(respuesta.datos);
      setPaso(6);
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const cancelarPrevia = async () => {
    if (previa) {
      try {
        await api.eliminar(`/imports/${previa.id_historico}`);
      } catch {
        // Si ya fue confirmada o expiro, no hay nada que cancelar.
      }
    }
    alCerrar();
  };

  const decisionesPendientes =
    previa?.gruposQueRequierenDecision.filter((g) => !decisiones[g.clave]).length ?? 0;

  const plantasPendientes =
    previa?.plantasNoResueltas.filter((p) => !mapeoPlantas[p]).length ?? 0;

  return (
    <Modal titulo="Asistente de carga de historicos" ancho alCerrar={() => void cancelarPrevia()}>
      <ol className="pasos">
        {PASOS.map((texto, indice) => (
          <li key={texto} aria-current={paso === indice ? 'step' : undefined} data-completado={paso > indice}>
            <span aria-hidden="true">{indice + 1}</span> {texto}
          </li>
        ))}
      </ol>

      {error ? <MensajeError error={error} /> : null}

      {/* ---------------- Paso 1: destino ---------------- */}
      {paso === 0 ? (
        <>
          <MensajeInfo titulo="Seleccione el destino de la carga">
            Para el <strong>formato historico</strong> (Planta, Tipo, Año, Mes, Generacion) puede dejar los
            campos vacios: el sistema identifica cada planta por su nombre. Para la{' '}
            <strong>plantilla normalizada</strong> debe elegir al menos el proyecto.
          </MensajeInfo>
          <div className="formulario">
            <CampoSelect
              etiqueta="Cliente"
              value=""
              onChange={() => undefined}
              disabled
              ayuda="El cliente se deduce del proyecto seleccionado."
            >
              <option value="">Segun el proyecto</option>
            </CampoSelect>
            <CampoSelect
              etiqueta="Proyecto"
              value={idProyecto}
              onChange={(e) => {
                setIdProyecto(e.target.value);
                setIdInversor('');
              }}
            >
              <option value="">Determinar por el nombre de la planta</option>
              {catalogos.proyectos.map((p) => (
                <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
              ))}
            </CampoSelect>
            <CampoSelect
              etiqueta="Inversor"
              value={idInversor}
              ayuda="Selecciónelo si todo el archivo pertenece a un unico equipo."
              onChange={(e) => setIdInversor(e.target.value)}
            >
              <option value="">Sin inversor especifico</option>
              {catalogos.inversores
                .filter((i) => !idProyecto || String(i.id_proyecto) === idProyecto)
                .map((i) => (
                  <option key={i.id_inversor} value={i.id_inversor}>
                    {i.marca} {i.modelo} {i.serial_externo ? `(${i.serial_externo})` : ''}
                  </option>
                ))}
            </CampoSelect>
            <CampoTexto
              etiqueta="Año (solo si el archivo no lo trae)"
              type="number"
              min="2000"
              max="2100"
              value={anioForzado}
              placeholder={String(anioActual())}
              ayuda="El sistema nunca adivina el año: si el archivo no lo incluye, indiquelo aqui."
              onChange={(e) => setAnioForzado(e.target.value)}
            />
          </div>
          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" className="boton boton--secundario" onClick={alCerrar}>
              Cancelar
            </button>
            <button type="button" className="boton" onClick={() => setPaso(1)}>
              Continuar
            </button>
          </div>
        </>
      ) : null}

      {/* ---------------- Paso 2: plantilla ---------------- */}
      {paso === 1 ? (
        <>
          <MensajeInfo titulo="Descargue la plantilla adecuada">
            Las plantillas incluyen una hoja de instrucciones con el significado y las reglas de cada
            columna. El archivo de ejemplo con errores sirve para comprobar la validacion.
          </MensajeInfo>
          <div className="acciones" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void descargar('/imports/template', { formato: 'HISTORICO_EXCEL', tipo: 'xlsx' })}
            >
              Plantilla historica (XLSX)
            </button>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void descargar('/imports/template', { formato: 'HISTORICO_EXCEL', tipo: 'csv' })}
            >
              Plantilla historica (CSV)
            </button>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void descargar('/imports/template', { formato: 'NORMALIZADO', tipo: 'xlsx' })}
            >
              Plantilla normalizada (XLSX)
            </button>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void descargar('/imports/template', { tipo: 'errores' })}
            >
              Ejemplo con errores (CSV)
            </button>
          </div>
          <div className="acciones" style={{ marginTop: '1.2rem', justifyContent: 'space-between' }}>
            <button type="button" className="boton boton--secundario" onClick={() => setPaso(0)}>
              Atras
            </button>
            <button type="button" className="boton" onClick={() => setPaso(2)}>
              Continuar
            </button>
          </div>
        </>
      ) : null}

      {/* ---------------- Paso 3: archivo ---------------- */}
      {paso === 2 ? (
        <>
          <div className="campo campo--ancho">
            <label htmlFor="archivo-importacion">
              Archivo a cargar <span className="obligatorio" aria-hidden="true">*</span>
            </label>
            <input
              id="archivo-importacion"
              type="file"
              accept=".csv,.xlsx"
              onChange={elegirArchivo}
              aria-describedby="ayuda-archivo"
            />
            <span className="campo__ayuda" id="ayuda-archivo">
              Formatos permitidos: CSV o XLSX. Maximo 10 MB. No se aceptan libros con macros ni vinculos
              externos; las formulas se leen por su resultado, nunca se ejecutan.
            </span>
          </div>

          {archivo ? (
            <p style={{ fontSize: '0.85rem' }}>
              Seleccionado: <strong>{archivo.name}</strong> ({numero(archivo.size / 1024, 1)} KB)
            </p>
          ) : null}

          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
            <button type="button" className="boton boton--secundario" onClick={() => setPaso(1)}>
              Atras
            </button>
            <button type="button" className="boton" onClick={() => void validar()} disabled={!archivo || ocupado}>
              {ocupado ? 'Validando archivo...' : 'Validar y previsualizar'}
            </button>
          </div>
        </>
      ) : null}

      {/* ---------------- Pasos 4 y 5: previsualizacion y decisiones ---------------- */}
      {paso >= 3 && paso <= 5 && previa ? (
        <>
          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">Filas leidas</p>
              <p className="indicador__valor">{previa.totales.filasLeidas}</p>
            </div>
            <div className="indicador indicador--verde">
              <p className="indicador__etiqueta">Filas validas</p>
              <p className="indicador__valor">{previa.totales.validas}</p>
            </div>
            <div className={previa.totales.errores > 0 ? 'indicador indicador--rojo' : 'indicador'}>
              <p className="indicador__etiqueta">Con error</p>
              <p className="indicador__valor">{previa.totales.errores}</p>
            </div>
            <div className={previa.totales.duplicados > 0 ? 'indicador indicador--ambar' : 'indicador'}>
              <p className="indicador__etiqueta">Duplicados detectados</p>
              <p className="indicador__valor">{previa.totales.duplicados}</p>
            </div>
          </section>

          <p style={{ fontSize: '0.86rem' }}>
            Formato detectado: <strong>{textoEstado(previa.formato)}</strong> · Nivel de detalle del lote:{' '}
            <strong>{textoEstado(previa.nivelDetalleLote)}</strong> · Columnas:{' '}
            {previa.encabezados.join(', ')}
          </p>

          {previa.periodosCerrados.length > 0 ? (
            <MensajeAlerta titulo="Periodos cerrados en el archivo">
              No se puede confirmar la carga porque incluye periodos cerrados:{' '}
              {previa.periodosCerrados.map((p) => `${p.proyecto} ${p.mes}/${p.anio}`).join(', ')}. Solicite la
              reapertura a un administrador.
            </MensajeAlerta>
          ) : null}

          {previa.conflictosNivelDetalle.length > 0 ? (
            <MensajeAlerta titulo="Riesgo de doble conteo">
              Para {previa.conflictosNivelDetalle.length} periodo(s) ya existe produccion registrada con un
              nivel de detalle distinto al del archivo. Mezclarlos duplicaria la energia. Revise el caso y, si
              esta seguro, marque la confirmacion explicita mas abajo.
              <ul style={{ margin: '0.5rem 0 0 1rem' }}>
                {previa.conflictosNivelDetalle.map((c, i) => (
                  <li key={i}>
                    {c.proyecto} {nombreMes(c.mes)} {c.anio}: existente {textoEstado(c.existente)}, entrante{' '}
                    {textoEstado(c.entrante)}
                  </li>
                ))}
              </ul>
            </MensajeAlerta>
          ) : null}

          {previa.mesesSinTarifaAprobada.length > 0 ? (
            <MensajeAlerta titulo="Meses sin tarifa aprobada">
              {previa.mesesSinTarifaAprobada.length} periodo(s) del archivo no tienen tarifa aprobada. Los kWh
              se cargaran normalmente, pero su valor economico quedara pendiente hasta que se registre y
              apruebe la tarifa correspondiente.
            </MensajeAlerta>
          ) : null}

          {previa.plantasNoResueltas.length > 0 ? (
            <section className="tarjeta">
              <h3>Plantas no encontradas</h3>
              <p style={{ fontSize: '0.86rem' }}>
                Estos nombres del archivo no coinciden con ningun proyecto registrado. Asignelos manualmente
                o cree el proyecto antes de continuar.
              </p>
              {previa.plantasNoResueltas.map((planta) => (
                <CampoSelect
                  key={planta}
                  etiqueta={`Planta "${planta}"`}
                  obligatorio
                  value={mapeoPlantas[planta] ?? ''}
                  onChange={(e) => setMapeoPlantas({ ...mapeoPlantas, [planta]: e.target.value })}
                >
                  <option value="">Seleccione el proyecto correspondiente</option>
                  {catalogos.proyectos.map((p) => (
                    <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
                  ))}
                </CampoSelect>
              ))}
            </section>
          ) : null}

          {previa.gruposQueRequierenDecision.length > 0 ? (
            <section className="tarjeta">
              <h3>Grupos que requieren una decision</h3>
              <MensajeAlerta>
                Varias filas de la misma planta y mes <strong>no son duplicados automaticos</strong>. Indique
                que debe hacer el sistema con cada grupo. La decision queda registrada en la auditoria.
              </MensajeAlerta>
              {previa.gruposQueRequierenDecision.map((grupo) => (
                <fieldset key={grupo.clave}>
                  <legend>
                    {grupo.planta} · {grupo.mesNombre} {grupo.anio} · {grupo.filas} filas ·{' '}
                    {kwh(grupo.kwhTotal)}
                  </legend>
                  {grupo.opciones.map((opcion) => (
                    <div key={opcion.valor} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem' }}>
                      <input
                        type="radio"
                        id={`${grupo.clave}-${opcion.valor}`}
                        name={grupo.clave}
                        value={opcion.valor}
                        checked={decisiones[grupo.clave] === opcion.valor}
                        onChange={() => setDecisiones({ ...decisiones, [grupo.clave]: opcion.valor })}
                        style={{ marginTop: '0.25rem', width: 'auto' }}
                      />
                      <label htmlFor={`${grupo.clave}-${opcion.valor}`} style={{ fontWeight: 500, fontSize: '0.85rem' }}>
                        <strong>{opcion.valor}</strong> — {opcion.descripcion}
                      </label>
                    </div>
                  ))}
                  {decisiones[grupo.clave] === 'MAPEAR' ? (
                    <MensajeInfo>
                      El mapeo fila por fila a inversores debe realizarse agregando una columna{' '}
                      <strong>Inversor</strong> o <strong>Serial</strong> al archivo. Vuelva a cargarlo con
                      esa columna para asignar cada fila a su equipo.
                    </MensajeInfo>
                  ) : null}
                </fieldset>
              ))}
            </section>
          ) : null}

          <section className="tarjeta">
            <h3>Previsualizacion de registros validos</h3>
            <Tabla
              columnas={[
                { clave: 'fila', titulo: 'Fila', numerica: true, render: (f) => f.fila },
                { clave: 'planta', titulo: 'Planta', render: (f) => f.planta ?? '—' },
                { clave: 'tipo', titulo: 'Modalidad', render: (f) => f.tipo ?? '—' },
                { clave: 'periodo', titulo: 'Periodo', render: (f) => `${nombreMes(f.mes)} ${f.anio}` },
                { clave: 'fecha', titulo: 'Fecha', render: (f) => fecha(f.fecha) },
                { clave: 'kwh', titulo: 'Energia', numerica: true, render: (f) => kwh(f.kwh) },
                { clave: 'serial', titulo: 'Inversor', render: (f) => f.serial ?? 'Consolidado' },
                { clave: 'coment', titulo: 'Comentarios', render: (f) => f.comentarios ?? '—' },
              ]}
              filas={previa.muestra}
              claveFila={(f) => f.fila}
              vacioTitulo="El archivo no contiene filas validas"
            />
            {previa.totales.validas > previa.muestra.length ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--texto-suave)' }}>
                Mostrando las primeras {previa.muestra.length} de {previa.totales.validas} filas validas.
              </p>
            ) : null}
          </section>

          {previa.problemas.length > 0 ? (
            <section className="tarjeta">
              <h3>Errores y advertencias detectados</h3>
              <Tabla
                columnas={[
                  { clave: 'fila', titulo: 'Fila', numerica: true, render: (f) => f.fila || '—' },
                  { clave: 'columna', titulo: 'Columna', render: (f) => f.columna ?? '—' },
                  { clave: 'valor', titulo: 'Valor', render: (f) => f.valor ?? '—' },
                  {
                    clave: 'sev',
                    titulo: 'Severidad',
                    render: (f) => (
                      <span className={f.severidad === 'ERROR' ? 'etiqueta etiqueta--rojo' : 'etiqueta etiqueta--ambar'}>
                        {f.severidad}
                      </span>
                    ),
                  },
                  { clave: 'mensaje', titulo: 'Mensaje', render: (f) => f.mensaje },
                ]}
                filas={previa.problemas}
                claveFila={(f) => `${f.fila}-${f.codigo}-${f.columna}`}
                vacioTitulo="Sin problemas"
              />
            </section>
          ) : null}

          <section className="tarjeta">
            <h3>Opciones de confirmacion</h3>
            <div className="formulario">
              <CampoSelect
                etiqueta="Politica ante duplicados"
                value={politicaDuplicados}
                ayuda="Un duplicado es una fila que coincide con la clave de unicidad ya existente."
                onChange={(e) => setPoliticaDuplicados(e.target.value as 'ACTUALIZAR' | 'OMITIR')}
              >
                <option value="ACTUALIZAR">Actualizar el registro existente</option>
                <option value="OMITIR">Omitir y conservar el valor actual</option>
              </CampoSelect>
            </div>

            {previa.requiereConfirmarCargaParcial ? (
              <CampoCasilla
                etiqueta={`Acepto la carga parcial: se descartaran ${previa.filasQueSeDescartaran} fila(s) con error`}
                ancho
                checked={aceptarParcial}
                ayuda="Las filas validas si se cargaran. Podra descargar el detalle de las descartadas."
                onChange={(e) => setAceptarParcial(e.target.checked)}
              />
            ) : null}

            {previa.conflictosNivelDetalle.length > 0 ? (
              <CampoCasilla
                etiqueta="Confirmo mezclar niveles de detalle pese al riesgo de doble conteo"
                ancho
                checked={confirmarMezcla}
                ayuda="Solo marque esta casilla si verifico que la energia no se contara dos veces."
                onChange={(e) => setConfirmarMezcla(e.target.checked)}
              />
            ) : null}

            <p style={{ fontSize: '0.84rem', color: 'var(--texto-suave)' }}>{previa.mensaje}</p>
          </section>

          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
            <button type="button" className="boton boton--secundario" onClick={() => void cancelarPrevia()}>
              Cancelar importacion
            </button>
            <button
              type="button"
              className="boton"
              disabled={
                ocupado ||
                !previa.puedeConfirmar ||
                decisionesPendientes > 0 ||
                plantasPendientes > 0 ||
                (previa.requiereConfirmarCargaParcial && !aceptarParcial) ||
                (previa.conflictosNivelDetalle.length > 0 && !confirmarMezcla)
              }
              onClick={() => void confirmar()}
            >
              {ocupado ? 'Procesando...' : 'Confirmar carga'}
            </button>
          </div>

          {decisionesPendientes > 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--rojo-700)', textAlign: 'right' }}>
              Faltan {decisionesPendientes} decision(es) de grupo por resolver.
            </p>
          ) : null}
          {plantasPendientes > 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--rojo-700)', textAlign: 'right' }}>
              Faltan {plantasPendientes} planta(s) por asignar a un proyecto.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ---------------- Paso 7: resumen final ---------------- */}
      {paso === 6 && resultado ? (
        <>
          <MensajeExito>{resultado.mensaje}</MensajeExito>

          <section className="rejilla">
            <div className="indicador indicador--verde">
              <p className="indicador__etiqueta">Insertadas</p>
              <p className="indicador__valor">{resultado.insertadas}</p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Actualizadas</p>
              <p className="indicador__valor">{resultado.actualizadas}</p>
            </div>
            <div className="indicador indicador--ambar">
              <p className="indicador__etiqueta">Omitidas por duplicidad</p>
              <p className="indicador__valor">{resultado.omitidas}</p>
            </div>
            <div className={resultado.rechazadas > 0 ? 'indicador indicador--rojo' : 'indicador'}>
              <p className="indicador__etiqueta">Rechazadas</p>
              <p className="indicador__valor">{resultado.rechazadas}</p>
            </div>
          </section>

          {resultado.pendientesTarifa > 0 ? (
            <MensajeAlerta titulo="Registros pendientes de valorizacion">
              {resultado.pendientesTarifa} registro(s) quedaron sin valor economico porque su mes no tiene
              tarifa aprobada. Registre la tarifa desde el detalle del proyecto y el sistema los valorizara
              automaticamente.
            </MensajeAlerta>
          ) : null}

          <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="boton boton--secundario"
              onClick={() => void descargar(`/imports/${resultado.id_historico}/errors`)}
            >
              Descargar detalle de errores
            </button>
            <button type="button" className="boton" onClick={alCerrar}>
              Finalizar
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
