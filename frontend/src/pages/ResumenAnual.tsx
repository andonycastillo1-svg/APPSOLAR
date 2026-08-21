import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoSelect } from '../components/Campos';
import { Cargando, MensajeAlerta, MensajeError, MensajeInfo } from '../components/Estados';
import { GraficaComparativa } from '../components/Graficas';
import { anioActual, kwh, numero, porcentaje, quetzales, tarifa } from '../lib/formato';

interface FilaAnual {
  mes: number;
  mesNombre: string;
  proyeccion_kwh: number | null;
  generacion_anio_anterior: number;
  cumplimiento_anio_anterior: number | null;
  generacion_anio_seleccionado: number;
  cumplimiento_anio_seleccionado: number | null;
  tarifa_q_kwh: number | null;
  estado_tarifa: string | null;
  valor_producido_q: number | null;
  pendiente_de_tarifa: boolean;
  comentarios: string | null;
}

interface RespuestaAnual {
  filas: FilaAnual[];
  totales: Record<string, number | null>;
}

/**
 * Vista equivalente al resumen del Excel de referencia:
 * selectores de anio/mes/planta, filas de enero a diciembre, columnas de
 * proyeccion, anio anterior, cumplimiento, tarifa y valor producido.
 */
export function PaginaResumenAnual() {
  const catalogos = useCatalogos();
  const [anio, setAnio] = useState(anioActual());
  const [idProyecto, setIdProyecto] = useState('');
  const [idCliente, setIdCliente] = useState('');
  const [mesDestacado, setMesDestacado] = useState('');

  const anios = useMemo(() => {
    const base = anioActual();
    return Array.from({ length: 8 }, (_, i) => base - i);
  }, []);

  const proyectosFiltrados = useMemo(
    () => (idCliente ? catalogos.proyectos.filter((p) => String(p.id_cliente) === idCliente) : catalogos.proyectos),
    [catalogos.proyectos, idCliente],
  );

  const consulta = useQuery({
    queryKey: ['resumen-anual', anio, idProyecto, idCliente],
    queryFn: async () =>
      (
        await api.obtener<RespuestaAnual>('/production/annual-summary', {
          anio,
          id_proyecto: idProyecto || undefined,
          id_cliente: idCliente || undefined,
        })
      ).datos,
  });

  const datos = consulta.data;
  const proyectoSeleccionado = proyectosFiltrados.find((p) => String(p.id_proyecto) === idProyecto);
  const mesesPendientes = Number(datos?.totales.mesesPendientes ?? 0);

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Resumen anual de generacion</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Proyeccion, generacion del anio anterior, cumplimiento, tarifa mensual y valor producido.
          </p>
        </div>
        <button type="button" className="boton boton--secundario no-imprimir" onClick={() => window.print()}>
          Imprimir resumen
        </button>
      </div>

      <section className="tarjeta no-imprimir">
        <div className="filtros">
          <CampoSelect etiqueta="Anio" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
            {anios.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Cliente"
            value={idCliente}
            onChange={(e) => {
              setIdCliente(e.target.value);
              setIdProyecto('');
            }}
          >
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Planta / Proyecto"
            value={idProyecto}
            onChange={(e) => setIdProyecto(e.target.value)}
            ayuda={idProyecto ? undefined : 'La tarifa mensual solo se muestra al elegir un proyecto.'}
          >
            <option value="">Todos los proyectos</option>
            {proyectosFiltrados.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Destacar mes" value={mesDestacado} onChange={(e) => setMesDestacado(e.target.value)}>
            <option value="">Sin destacar</option>
            {datos?.filas.map((f) => (
              <option key={f.mes} value={f.mes}>{f.mesNombre}</option>
            ))}
          </CampoSelect>
        </div>
      </section>

      {consulta.isLoading ? <Cargando /> : null}
      {consulta.error ? <MensajeError error={consulta.error} alReintentar={() => void consulta.refetch()} /> : null}

      {datos ? (
        <>
          {mesesPendientes > 0 ? (
            <MensajeAlerta titulo="Valor producido parcial">
              {mesesPendientes} mes(es) del anio {anio} tienen generacion registrada pero no cuentan con una
              tarifa aprobada. Su energia se conserva; el valor en quetzales aparece como pendiente y el total
              mostrado NO es un monto oficial completo.
            </MensajeAlerta>
          ) : null}

          {!idProyecto ? (
            <MensajeInfo titulo="Vista consolidada">
              Esta seleccion agrupa varios proyectos. La columna de tarifa Q/kWh queda vacia porque cada
              proyecto tiene su propia tarifa mensual; el valor producido si se calcula por registro con la
              tarifa que corresponde a cada uno.
            </MensajeInfo>
          ) : null}

          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">Total generado {anio}</p>
              <p className="indicador__valor">{kwh(datos.totales.generacion_anio_seleccionado)}</p>
              <p className="indicador__detalle">
                Anio {anio - 1}: {kwh(datos.totales.generacion_anio_anterior)}
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Proyeccion anual</p>
              <p className="indicador__valor">
                {Number(datos.totales.proyeccion_kwh ?? 0) > 0 ? kwh(datos.totales.proyeccion_kwh) : 'Sin proyeccion'}
              </p>
              <p className="indicador__detalle">Suma de los meses con proyeccion aprobada</p>
            </div>
            <div
              className={
                datos.totales.cumplimiento_anio_seleccionado === null
                  ? 'indicador'
                  : Number(datos.totales.cumplimiento_anio_seleccionado) >= 100
                    ? 'indicador indicador--verde'
                    : 'indicador indicador--ambar'
              }
            >
              <p className="indicador__etiqueta">Cumplimiento {anio}</p>
              <p className="indicador__valor">{porcentaje(datos.totales.cumplimiento_anio_seleccionado)}</p>
              <p className="indicador__detalle">
                Anio {anio - 1}: {porcentaje(datos.totales.cumplimiento_anio_anterior)}
              </p>
            </div>
            <div className={mesesPendientes > 0 ? 'indicador indicador--ambar' : 'indicador indicador--verde'}>
              <p className="indicador__etiqueta">Valor total producido</p>
              <p className="indicador__valor">{quetzales(datos.totales.valor_producido_q)}</p>
              <p className="indicador__detalle">
                {mesesPendientes > 0 ? `Parcial: ${mesesPendientes} mes(es) sin tarifa` : 'Cobertura tarifaria completa'}
              </p>
            </div>
          </section>

          <section className="tarjeta">
            <h2>
              Comparacion: proyeccion, {anio - 1} y {anio}
              {proyectoSeleccionado ? ` · ${proyectoSeleccionado.nombre}` : ''}
            </h2>
            <GraficaComparativa filas={datos.filas} anio={anio} />
          </section>

          <section className="tarjeta">
            <h2>Detalle mensual</h2>
            <div className="tabla-envoltura">
              <table>
                <caption>
                  Resumen mensual del anio {anio}
                  {proyectoSeleccionado ? ` para ${proyectoSeleccionado.nombre}` : ' (todos los proyectos)'}.
                  Energia en kWh, tarifa en Q/kWh y valor en quetzales.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
                    <th scope="col" className="num">Proyeccion kWh</th>
                    <th scope="col" className="num">Generacion {anio - 1}</th>
                    <th scope="col" className="num">% cumpl. {anio - 1}</th>
                    <th scope="col" className="num">Generacion {anio}</th>
                    <th scope="col" className="num">% cumpl. {anio}</th>
                    <th scope="col" className="num">Tarifa Q/kWh</th>
                    <th scope="col" className="num">Valor producido Q</th>
                    <th scope="col">Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.filas.map((fila) => (
                    <tr
                      key={fila.mes}
                      style={
                        String(fila.mes) === mesDestacado
                          ? { background: 'var(--ambar-100)', fontWeight: 600 }
                          : undefined
                      }
                    >
                      <th scope="row" style={{ position: 'static', background: 'transparent', borderBottom: '1px solid var(--gris-200)' }}>
                        {fila.mesNombre}
                      </th>
                      <td className="num">
                        {fila.proyeccion_kwh === null ? (
                          <span style={{ color: 'var(--texto-suave)' }}>Sin proyeccion</span>
                        ) : (
                          numero(fila.proyeccion_kwh)
                        )}
                      </td>
                      <td className="num">{numero(fila.generacion_anio_anterior)}</td>
                      <td className="num">{porcentaje(fila.cumplimiento_anio_anterior)}</td>
                      <td className="num">{numero(fila.generacion_anio_seleccionado)}</td>
                      <td className="num">
                        {fila.cumplimiento_anio_seleccionado === null ? (
                          <span style={{ color: 'var(--texto-suave)' }}>Sin proyeccion</span>
                        ) : (
                          <span
                            className={
                              fila.cumplimiento_anio_seleccionado >= 100
                                ? 'etiqueta etiqueta--verde'
                                : 'etiqueta etiqueta--ambar'
                            }
                          >
                            {porcentaje(fila.cumplimiento_anio_seleccionado)}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {fila.tarifa_q_kwh === null ? (
                          <span className="etiqueta etiqueta--rojo">Sin tarifa</span>
                        ) : (
                          numero(fila.tarifa_q_kwh, 6)
                        )}
                      </td>
                      <td className="num">
                        {fila.pendiente_de_tarifa ? (
                          <span className="etiqueta etiqueta--ambar">Pendiente de tarifa</span>
                        ) : (
                          quetzales(fila.valor_producido_q)
                        )}
                      </td>
                      <td>{fila.comentarios ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, background: 'var(--azul-050)' }}>
                    <th scope="row" style={{ position: 'static' }}>Total anual</th>
                    <td className="num">{numero(datos.totales.proyeccion_kwh)}</td>
                    <td className="num">{numero(datos.totales.generacion_anio_anterior)}</td>
                    <td className="num">{porcentaje(datos.totales.cumplimiento_anio_anterior)}</td>
                    <td className="num">{numero(datos.totales.generacion_anio_seleccionado)}</td>
                    <td className="num">{porcentaje(datos.totales.cumplimiento_anio_seleccionado)}</td>
                    <td className="num">—</td>
                    <td className="num">{quetzales(datos.totales.valor_producido_q)}</td>
                    <td>{mesesPendientes > 0 ? `${mesesPendientes} mes(es) pendiente(s)` : 'Completo'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--texto-suave)', marginTop: '0.7rem' }}>
              La tarifa mostrada es la tarifa mensual APROBADA del proyecto. El valor producido se calcula
              registro por registro con la tarifa de su propio mes y luego se suma: nunca se multiplica el
              total del anio por una sola tarifa.
              {proyectoSeleccionado ? ` Tarifa de referencia: ${tarifa(datos.filas.find((f) => f.tarifa_q_kwh !== null)?.tarifa_q_kwh ?? null)}.` : ''}
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
