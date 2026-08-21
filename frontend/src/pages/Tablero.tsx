import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoSelect, CampoTexto } from '../components/Campos';
import { Cargando, MensajeAlerta, MensajeError, MensajeInfo } from '../components/Estados';
import { GraficaDistribucion, GraficaSerie, GraficaBarrasComparacion } from '../components/Graficas';
import { Tabla } from '../components/Tabla';
import {
  claseEstado,
  fecha,
  fechaHora,
  hoyISO,
  inicioDeAnioISO,
  kwh,
  numero,
  porcentaje,
  quetzales,
  tarifa as formatoTarifa,
  textoEstado,
} from '../lib/formato';

interface RespuestaTablero {
  periodo: { desde: string; hasta: string; comparadoCon: { desde: string; hasta: string } };
  produccion: {
    periodo_kwh: number;
    valor_q: number;
    registros: number;
    dia_kwh: number;
    mes_kwh: number;
    anio_kwh: number;
  };
  variacion: {
    base: string;
    anterior_kwh: number;
    absoluta_kwh: number;
    porcentual_kwh: number | null;
    anterior_valor_q: number;
    absoluta_valor_q: number;
  };
  proyeccion: {
    kwh: number;
    mesesConProyeccion: number;
    mesesDelPeriodo: number;
    cumplimiento: number | null;
    etiqueta: string | null;
  };
  tarifas: {
    aplicadasPorMes: Array<{ anio: number; mes: number; proyecto: string; costo_kwh: number; etiqueta: string }>;
    cobertura: {
      mesesConTarifa: Array<{ anio: number; mes: number; costo_kwh: number }>;
      mesesPendientes: Array<{ anio: number; mes: number }>;
      registrosPendientes: number;
      kwhPendientes: number;
      completa: boolean;
    };
    advertencia: string | null;
  };
  catalogos: { clientes: number; proyectos: number; inversores: number };
  serie: Array<{ periodo: string; etiqueta: string; kwh: number; valor_q: number; pendientes: number }>;
  distribucionPorProyecto: Array<{
    id_proyecto: number;
    proyecto: string;
    cliente: string;
    kwh: number;
    valor_q: number;
    pendientes: number;
  }>;
  inversores: Array<{
    id_inversor: number;
    inversor: string;
    proyecto: string;
    capacidad_kwp: number | null;
    kwh: number;
    valor_q: number;
    ultima_fecha: string | null;
  }>;
  inversoresMenorRendimiento: Array<{
    id_inversor: number;
    inversor: string;
    proyecto: string;
    kwh: number;
    kwh_por_kwp: number;
    relativo: number | null;
  }>;
  rendimiento: {
    baseComparacion: string;
    promedioKwhPorKwp: number;
    noComparables: Array<{ inversor: string; razon: string }>;
  };
  actualizaciones: Array<{
    id_proyecto: number;
    proyecto: string;
    ultima_fecha: string | null;
    ultima_carga: string | null;
  }>;
  ultimaImportacion: {
    id_historico: number;
    nombre_archivo_original: string;
    estado: string;
    total_filas: number;
    insertadas: number;
    rechazadas: number;
    created_at: string;
    usuario: string | null;
  } | null;
  ultimaSincronizacion: {
    id_sync: number;
    estado: string;
    modo: string;
    tipo: string;
    rango_desde: string | null;
    rango_hasta: string | null;
    filas_recibidas: number;
    insertadas: number;
    mensaje: string | null;
    iniciada_en: string;
    usuario: string | null;
  } | null;
  periodosConMezclaDeNiveles: Array<{ proyecto: string; anio: number; mes: number }>;
  ambiental: {
    toneladas_co2_evitadas: number;
    arboles_equivalentes: number;
    factor_co2: number;
    factor_co2_unidad: string;
    factor_co2_fuente: string;
    co2_por_arbol: number;
    co2_por_arbol_unidad: string;
    co2_por_arbol_fuente: string;
  };
  meta: { moneda: string; unidadEnergia: string; zonaHoraria: string; generadoEn: string };
}

export function PaginaTablero() {
  const catalogos = useCatalogos();
  const [filtros, setFiltros] = useState({
    desde: inicioDeAnioISO(),
    hasta: hoyISO(),
    id_cliente: '',
    id_proyecto: '',
    id_inversor: '',
    granularidad: 'MENSUAL',
  });

  const proyectosFiltrados = useMemo(
    () =>
      filtros.id_cliente
        ? catalogos.proyectos.filter((p) => String(p.id_cliente) === filtros.id_cliente)
        : catalogos.proyectos,
    [catalogos.proyectos, filtros.id_cliente],
  );

  const inversoresFiltrados = useMemo(
    () =>
      filtros.id_proyecto
        ? catalogos.inversores.filter((i) => String(i.id_proyecto) === filtros.id_proyecto)
        : catalogos.inversores,
    [catalogos.inversores, filtros.id_proyecto],
  );

  const consulta = useQuery({
    queryKey: ['tablero', filtros],
    queryFn: async () => (await api.obtener<RespuestaTablero>('/dashboard', filtros)).datos,
  });

  const cambiar = (campo: string, valor: string) => {
    setFiltros((actual) => {
      const siguiente = { ...actual, [campo]: valor };
      if (campo === 'id_cliente') {
        siguiente.id_proyecto = '';
        siguiente.id_inversor = '';
      }
      if (campo === 'id_proyecto') siguiente.id_inversor = '';
      return siguiente;
    });
  };

  const datos = consulta.data;

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Tablero de indicadores energeticos</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Energia en kWh · Potencia instalada en kWp · Moneda GTQ (Q) · Zona horaria America/Guatemala
          </p>
        </div>
        <button type="button" className="boton boton--secundario no-imprimir" onClick={() => window.print()}>
          Imprimir tablero
        </button>
      </div>

      <section className="tarjeta no-imprimir" aria-labelledby="titulo-filtros">
        <h2 id="titulo-filtros" style={{ fontSize: '0.95rem' }}>Filtros globales</h2>
        <div className="filtros">
          <CampoTexto
            etiqueta="Desde"
            type="date"
            value={filtros.desde}
            max={filtros.hasta}
            onChange={(e) => cambiar('desde', e.target.value)}
          />
          <CampoTexto
            etiqueta="Hasta"
            type="date"
            value={filtros.hasta}
            min={filtros.desde}
            max={hoyISO()}
            onChange={(e) => cambiar('hasta', e.target.value)}
          />
          <CampoSelect etiqueta="Cliente" value={filtros.id_cliente} onChange={(e) => cambiar('id_cliente', e.target.value)}>
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Proyecto" value={filtros.id_proyecto} onChange={(e) => cambiar('id_proyecto', e.target.value)}>
            <option value="">Todos los proyectos</option>
            {proyectosFiltrados.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Inversor" value={filtros.id_inversor} onChange={(e) => cambiar('id_inversor', e.target.value)}>
            <option value="">Todos los inversores</option>
            {inversoresFiltrados.map((i) => (
              <option key={i.id_inversor} value={i.id_inversor}>
                {i.marca} {i.modelo} {i.serial_externo ? `(${i.serial_externo})` : ''}
              </option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Granularidad"
            value={filtros.granularidad}
            onChange={(e) => cambiar('granularidad', e.target.value)}
          >
            <option value="DIARIA">Diaria</option>
            <option value="MENSUAL">Mensual</option>
            <option value="ANUAL">Anual</option>
          </CampoSelect>
        </div>
      </section>

      {consulta.isLoading ? <Cargando mensaje="Calculando indicadores del periodo..." /> : null}
      {consulta.error ? <MensajeError error={consulta.error} alReintentar={() => void consulta.refetch()} /> : null}

      {datos ? (
        <>
          {datos.tarifas.advertencia ? (
            <MensajeAlerta titulo="Valorizacion parcial">
              {datos.tarifas.advertencia} Meses pendientes:{' '}
              {datos.tarifas.cobertura.mesesPendientes
                .map((m) => `${String(m.mes).padStart(2, '0')}/${m.anio}`)
                .join(', ')}
              . La energia registrada ({kwh(datos.tarifas.cobertura.kwhPendientes)}) se conserva intacta.
            </MensajeAlerta>
          ) : null}

          {datos.periodosConMezclaDeNiveles.length > 0 ? (
            <MensajeAlerta titulo="Periodos con dos niveles de detalle">
              En {datos.periodosConMezclaDeNiveles.length} periodo(s) coexisten un consolidado de proyecto y
              el detalle por inversor. Para evitar el doble conteo, el sistema utiliza unicamente el detalle
              por inversor en esos meses:{' '}
              {datos.periodosConMezclaDeNiveles
                .map((p) => `${p.proyecto} ${String(p.mes).padStart(2, '0')}/${p.anio}`)
                .join(' · ')}
              .
            </MensajeAlerta>
          ) : null}

          <section className="rejilla" aria-label="Indicadores principales">
            <div className="indicador">
              <p className="indicador__etiqueta">Produccion del periodo</p>
              <p className="indicador__valor">{kwh(datos.produccion.periodo_kwh)}</p>
              <p className="indicador__detalle">{datos.produccion.registros} registro(s)</p>
            </div>
            <div className={datos.tarifas.cobertura.completa ? 'indicador indicador--verde' : 'indicador indicador--ambar'}>
              <p className="indicador__etiqueta">Valor economico estimado</p>
              <p className="indicador__valor">{quetzales(datos.produccion.valor_q)}</p>
              <p className="indicador__detalle">
                {datos.tarifas.cobertura.completa ? 'Cobertura tarifaria completa' : 'Monto parcial: faltan tarifas'}
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Proyeccion del periodo</p>
              <p className="indicador__valor">
                {datos.proyeccion.kwh > 0 ? kwh(datos.proyeccion.kwh) : 'Sin proyeccion'}
              </p>
              <p className="indicador__detalle">
                {datos.proyeccion.mesesConProyeccion} de {datos.proyeccion.mesesDelPeriodo} mes(es) con proyeccion aprobada
              </p>
            </div>
            <div
              className={
                datos.proyeccion.cumplimiento === null
                  ? 'indicador'
                  : datos.proyeccion.cumplimiento >= 100
                    ? 'indicador indicador--verde'
                    : 'indicador indicador--ambar'
              }
            >
              <p className="indicador__etiqueta">Cumplimiento de la proyeccion</p>
              <p className="indicador__valor">
                {datos.proyeccion.cumplimiento === null ? 'Sin proyeccion' : porcentaje(datos.proyeccion.cumplimiento)}
              </p>
              <p className="indicador__detalle">generacion real / proyeccion x 100</p>
            </div>
            <div
              className={
                datos.variacion.porcentual_kwh === null
                  ? 'indicador'
                  : datos.variacion.porcentual_kwh >= 0
                    ? 'indicador indicador--verde'
                    : 'indicador indicador--rojo'
              }
            >
              <p className="indicador__etiqueta">Variacion vs. periodo anterior</p>
              <p className="indicador__valor">{porcentaje(datos.variacion.porcentual_kwh)}</p>
              <p className="indicador__detalle">
                {numero(datos.variacion.absoluta_kwh)} kWh · {datos.variacion.base}
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Produccion hoy / mes / anio</p>
              <p className="indicador__valor">{kwh(datos.produccion.dia_kwh)}</p>
              <p className="indicador__detalle">
                Mes: {kwh(datos.produccion.mes_kwh)} · Anio: {kwh(datos.produccion.anio_kwh)}
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Catalogos activos</p>
              <p className="indicador__valor">{datos.catalogos.proyectos} proyectos</p>
              <p className="indicador__detalle">
                {datos.catalogos.clientes} cliente(s) · {datos.catalogos.inversores} inversor(es)
              </p>
            </div>
            <div className="indicador indicador--verde">
              <p className="indicador__etiqueta">Equivalencia ambiental</p>
              <p className="indicador__valor">{numero(datos.ambiental.toneladas_co2_evitadas)} tCO2e</p>
              <p className="indicador__detalle">
                ≈ {numero(datos.ambiental.arboles_equivalentes, 0)} arbol(es) equivalentes
              </p>
            </div>
          </section>

          <details className="tarjeta">
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--azul-800)' }}>
              Factores de conversion ambiental utilizados
            </summary>
            <ul style={{ marginTop: '0.7rem', fontSize: '0.84rem', lineHeight: 1.6 }}>
              <li>
                Factor de emision: <strong>{numero(datos.ambiental.factor_co2, 4)}</strong>{' '}
                {datos.ambiental.factor_co2_unidad}. Fuente: {datos.ambiental.factor_co2_fuente}
              </li>
              <li>
                Absorcion por arbol: <strong>{numero(datos.ambiental.co2_por_arbol, 4)}</strong>{' '}
                {datos.ambiental.co2_por_arbol_unidad}. Fuente: {datos.ambiental.co2_por_arbol_fuente}
              </li>
            </ul>
            <p style={{ fontSize: '0.8rem', color: 'var(--texto-suave)', margin: 0 }}>
              Estos factores son configurables desde el modulo de Configuracion; no son constantes ocultas.
            </p>
          </details>

          <section className="tarjeta">
            <div className="tarjeta__titulo">
              <h2>Serie temporal de produccion</h2>
              <span className="etiqueta etiqueta--azul">Granularidad {textoEstado(filtros.granularidad)}</span>
            </div>
            <GraficaSerie datos={datos.serie} titulo="Produccion por periodo" />
          </section>

          <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
            <section className="tarjeta">
              <h2>Distribucion por proyecto</h2>
              <GraficaDistribucion datos={datos.distribucionPorProyecto} />
            </section>

            <section className="tarjeta">
              <h2>Comparacion entre inversores</h2>
              <GraficaBarrasComparacion
                datos={datos.inversores.slice(0, 10).map((i) => ({ nombre: i.inversor, valor: i.kwh }))}
              />
            </section>
          </div>

          <section className="tarjeta">
            <div className="tarjeta__titulo">
              <h2>Inversores con menor produccion relativa</h2>
              <span style={{ fontSize: '0.79rem', color: 'var(--texto-suave)' }}>
                Base de comparacion: {datos.rendimiento.baseComparacion}
              </span>
            </div>
            <Tabla
              columnas={[
                { clave: 'inversor', titulo: 'Inversor', render: (f) => f.inversor },
                { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (f) => kwh(f.kwh) },
                { clave: 'rel', titulo: 'kWh por kWp', numerica: true, render: (f) => numero(f.kwh_por_kwp) },
                {
                  clave: 'porc',
                  titulo: 'Relativo al promedio',
                  numerica: true,
                  render: (f) => (
                    <span className={f.relativo !== null && f.relativo < 90 ? 'etiqueta etiqueta--ambar' : 'etiqueta etiqueta--verde'}>
                      {porcentaje(f.relativo)}
                    </span>
                  ),
                },
              ]}
              filas={datos.inversoresMenorRendimiento}
              claveFila={(f) => f.id_inversor}
              vacioTitulo="No hay inversores comparables"
              vacioDescripcion="La comparacion relativa requiere inversores con potencia instalada (kWp) registrada y datos en el periodo."
            />
            {datos.rendimiento.noComparables.length > 0 ? (
              <MensajeInfo titulo="Inversores excluidos de la comparacion">
                {datos.rendimiento.noComparables.map((i) => i.inversor).join(', ')} — no tienen potencia
                instalada registrada, por lo que no existe una base comparable.
              </MensajeInfo>
            ) : null}
          </section>

          <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
            <section className="tarjeta">
              <h2>Tarifas aplicadas en el periodo</h2>
              <Tabla
                columnas={[
                  { clave: 'mes', titulo: 'Periodo', render: (f) => f.etiqueta },
                  { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                  { clave: 'costo', titulo: 'Tarifa', numerica: true, render: (f) => formatoTarifa(f.costo_kwh) },
                ]}
                filas={datos.tarifas.aplicadasPorMes}
                claveFila={(f) => `${f.anio}-${f.mes}-${f.proyecto}`}
                vacioTitulo="No hay tarifas aprobadas en el periodo"
                vacioDescripcion="Registre y apruebe las tarifas mensuales desde el detalle de cada proyecto."
              />
            </section>

            <section className="tarjeta">
              <h2>Ultima actualizacion por proyecto</h2>
              <Tabla
                columnas={[
                  {
                    clave: 'proyecto',
                    titulo: 'Proyecto',
                    render: (f) => <Link to={`/proyectos/${f.id_proyecto}`}>{f.proyecto}</Link>,
                  },
                  { clave: 'dato', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_fecha) },
                  { clave: 'carga', titulo: 'Ultima carga', render: (f) => fechaHora(f.ultima_carga) },
                ]}
                filas={datos.actualizaciones}
                claveFila={(f) => f.id_proyecto}
                vacioTitulo="Sin proyectos activos"
              />
            </section>
          </div>

          <section className="tarjeta">
            <h2>Estado de las ultimas operaciones de datos</h2>
            <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <div>
                <h3>Ultima carga manual</h3>
                {datos.ultimaImportacion ? (
                  <ul style={{ fontSize: '0.86rem', lineHeight: 1.65, paddingLeft: '1.1rem' }}>
                    <li>Archivo: {datos.ultimaImportacion.nombre_archivo_original}</li>
                    <li>
                      Estado:{' '}
                      <span className={claseEstado(datos.ultimaImportacion.estado)}>
                        {textoEstado(datos.ultimaImportacion.estado)}
                      </span>
                    </li>
                    <li>
                      {datos.ultimaImportacion.insertadas} insertada(s) de {datos.ultimaImportacion.total_filas} fila(s);{' '}
                      {datos.ultimaImportacion.rechazadas} rechazada(s)
                    </li>
                    <li>Usuario: {datos.ultimaImportacion.usuario ?? 'No disponible'}</li>
                    <li>Fecha: {fechaHora(datos.ultimaImportacion.created_at)}</li>
                  </ul>
                ) : (
                  <p style={{ color: 'var(--texto-suave)' }}>Aun no se ha registrado ninguna importacion.</p>
                )}
              </div>

              <div>
                <h3>Ultima sincronizacion Huawei</h3>
                {datos.ultimaSincronizacion ? (
                  <ul style={{ fontSize: '0.86rem', lineHeight: 1.65, paddingLeft: '1.1rem' }}>
                    <li>
                      Estado:{' '}
                      <span className={claseEstado(datos.ultimaSincronizacion.estado)}>
                        {textoEstado(datos.ultimaSincronizacion.estado)}
                      </span>{' '}
                      {datos.ultimaSincronizacion.modo === 'MOCK' ? (
                        <span className="etiqueta etiqueta--azul">Datos simulados</span>
                      ) : null}
                    </li>
                    <li>
                      Rango: {fecha(datos.ultimaSincronizacion.rango_desde)} –{' '}
                      {fecha(datos.ultimaSincronizacion.rango_hasta)}
                    </li>
                    <li>
                      {datos.ultimaSincronizacion.filas_recibidas} fila(s) recibida(s),{' '}
                      {datos.ultimaSincronizacion.insertadas} insertada(s)
                    </li>
                    <li>{datos.ultimaSincronizacion.mensaje}</li>
                    <li>Fecha: {fechaHora(datos.ultimaSincronizacion.iniciada_en)}</li>
                  </ul>
                ) : (
                  <p style={{ color: 'var(--texto-suave)' }}>Aun no se ha ejecutado ninguna sincronizacion.</p>
                )}
              </div>
            </div>
          </section>

          <p style={{ fontSize: '0.76rem', color: 'var(--texto-suave)' }}>
            Datos generados el {fechaHora(datos.meta.generadoEn)} · Zona horaria {datos.meta.zonaHoraria} ·
            Moneda {datos.meta.moneda} · Energia {datos.meta.unidadEnergia}
          </p>
        </>
      ) : null}
    </>
  );
}
