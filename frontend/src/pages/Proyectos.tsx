import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import {
  Confirmacion,
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
} from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { anioActual, fecha, kwh, kwp, nombreMes, numero, quetzales } from '../lib/formato';

interface Proyecto {
  id_proyecto: number;
  id_cliente: number;
  nombre: string;
  cliente: string;
  ubicacion: string | null;
  tipo_proyecto: string;
  capacidad_kwp: number | null;
  fecha_inicio: string | null;
  activo: number;
  inversores: number;
  kwh_por_inversor: number;
  kwh_consolidado: number;
  valor_q_total: number;
  registros_pendientes: number;
  ultima_produccion: string | null;
}

const VACIO = {
  id_cliente: '',
  nombre: '',
  ubicacion: '',
  tipo_proyecto: 'PPA',
  capacidad_kwp: '',
  fecha_inicio: '',
  observaciones: '',
  activo: true,
};

/**
 * Alta de un proyecto: asistente de tres pasos.
 *
 *   1. Datos generales del proyecto.
 *   2. Proyeccion anual repartida mes a mes (obligatoria: es la base contra la
 *      que despues se mide el cumplimiento real de la planta).
 *   3. Grupos de inversores, con la cantidad de equipos que llevara cada uno y
 *      si cuenta con banco de baterias.
 */
interface GrupoNuevo {
  nombre: string;
  cantidad_inversores_declarada: string;
  tiene_banco_baterias: boolean;
  capacidad_baterias_kwh: string;
  capacidad_kwp: string;
  ubicacion: string;
}

const GRUPO_VACIO: GrupoNuevo = {
  nombre: '',
  cantidad_inversores_declarada: '',
  tiene_banco_baterias: false,
  capacidad_baterias_kwh: '',
  capacidad_kwp: '',
  ubicacion: '',
};

const MESES_VACIOS = () => Array.from({ length: 12 }, () => '');

const PASOS = [
  { numero: 1, titulo: 'Datos del proyecto' },
  { numero: 2, titulo: 'Proyeccion anual' },
  { numero: 3, titulo: 'Grupos de inversores' },
] as const;

export function PaginaProyectos() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();
  const clienteConsultas = useQueryClient();
  const [parametros] = useSearchParams();

  const listado = useListado<Proyecto>('proyectos', '/projects', { orden: 'nombre' });

  useEffect(() => {
    const cliente = parametros.get('cliente');
    if (cliente) listado.actualizar({ id_cliente: cliente });
    // Solo debe ejecutarse cuando cambia el parametro de la URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parametros]);

  const [formulario, setFormulario] = useState<typeof VACIO | null>(null);
  const [editando, setEditando] = useState<number | null>(null);
  const [paso, setPaso] = useState(1);
  const [anioProyeccion, setAnioProyeccion] = useState(anioActual());
  const [mesesProyeccion, setMesesProyeccion] = useState<string[]>(MESES_VACIOS);
  const [gruposNuevos, setGruposNuevos] = useState<GrupoNuevo[]>([{ ...GRUPO_VACIO }]);
  const [aEliminar, setAEliminar] = useState<Proyecto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const gestionar = puede('proyectos.gestionar');

  /** Abre el asistente en blanco. */
  const abrirAlta = () => {
    setEditando(null);
    setError(null);
    setPaso(1);
    setAnioProyeccion(anioActual());
    setMesesProyeccion(MESES_VACIOS());
    setGruposNuevos([{ ...GRUPO_VACIO }]);
    setFormulario({ ...VACIO });
  };

  const cerrarFormulario = () => {
    setFormulario(null);
    setPaso(1);
  };

  // --- Validaciones de cada paso ------------------------------------------
  const mesesNumericos = mesesProyeccion.map((valor) => (valor === '' ? null : Number(valor)));
  const mesesIncompletos = mesesNumericos.some((valor) => valor === null || Number.isNaN(valor));
  const mesesNegativos = mesesNumericos.some((valor) => valor !== null && valor < 0);
  const totalProyectado = mesesNumericos.reduce<number>((a, v) => a + (v ?? 0), 0);

  const gruposConNombre = gruposNuevos.filter((g) => g.nombre.trim() !== '');
  const nombresRepetidos =
    new Set(gruposConNombre.map((g) => g.nombre.trim().toLowerCase())).size !==
    gruposConNombre.length;
  const gruposIncoherentes = gruposConNombre.some(
    (g) => !g.tiene_banco_baterias && g.capacidad_baterias_kwh !== '',
  );

  const errorDelPaso = (): string | null => {
    if (!formulario) return null;
    if (paso === 1) {
      if (!formulario.id_cliente) return 'Seleccione el cliente propietario del proyecto.';
      if (formulario.nombre.trim().length < 3) return 'Indique el nombre de la planta.';
      return null;
    }
    if (paso === 2) {
      if (mesesIncompletos) {
        return 'Capture la proyeccion de los 12 meses. Puede escribir 0 en los meses sin generacion prevista.';
      }
      if (mesesNegativos) return 'La proyeccion mensual no puede ser negativa.';
      return null;
    }
    if (nombresRepetidos) return 'Hay dos grupos con el mismo nombre.';
    if (gruposIncoherentes) {
      return 'Un grupo sin banco de baterias no puede declarar capacidad de baterias.';
    }
    return null;
  };

  /** Reparte un total anual entre los 12 meses en partes iguales. */
  const repartirAnual = (total: number) => {
    const porMes = Math.round((total / 12) * 10000) / 10000;
    const doce = Array.from({ length: 12 }, () => porMes);
    // El ultimo mes absorbe el redondeo para que la suma sea exacta.
    doce[11] = Math.round((total - porMes * 11) * 10000) / 10000;
    setMesesProyeccion(doce.map((v) => String(v)));
  };

  const refrescar = () => {
    listado.recargar();
    void clienteConsultas.invalidateQueries({ queryKey: ['catalogo', 'proyectos'] });
  };

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!formulario) return;
    setOcupado(true);
    setError(null);
    try {
      const cuerpo = {
        ...formulario,
        id_cliente: Number(formulario.id_cliente),
        capacidad_kwp: formulario.capacidad_kwp === '' ? null : Number(formulario.capacidad_kwp),
        ubicacion: formulario.ubicacion || null,
        fecha_inicio: formulario.fecha_inicio || null,
        observaciones: formulario.observaciones || null,
      };
      if (editando) {
        await api.actualizar(`/projects/${editando}`, cuerpo);
        setExito('Proyecto actualizado correctamente.');
      } else {
        const respuesta = await api.crear<{ mensaje: string }>('/projects', {
          ...cuerpo,
          proyeccion: {
            anio: anioProyeccion,
            aprobarInmediato: true,
            meses: mesesNumericos.map((valor, indice) => ({
              mes: indice + 1,
              proyeccion_kwh: valor ?? 0,
            })),
          },
          grupos: gruposConNombre.map((g) => ({
            nombre: g.nombre.trim(),
            cantidad_inversores_declarada:
              g.cantidad_inversores_declarada === ''
                ? null
                : Number(g.cantidad_inversores_declarada),
            tiene_banco_baterias: g.tiene_banco_baterias,
            capacidad_baterias_kwh:
              g.capacidad_baterias_kwh === '' ? null : Number(g.capacidad_baterias_kwh),
            capacidad_kwp: g.capacidad_kwp === '' ? null : Number(g.capacidad_kwp),
            ubicacion: g.ubicacion || null,
          })),
        });
        setExito(respuesta.datos.mensaje);
      }
      cerrarFormulario();
      refrescar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    setOcupado(true);
    try {
      const respuesta = await api.eliminar<{ mensaje: string }>(`/projects/${aEliminar.id_proyecto}`);
      setExito(respuesta.datos.mensaje);
      setAEliminar(null);
      refrescar();
    } catch (fallo) {
      setError(fallo);
      setAEliminar(null);
    } finally {
      setOcupado(false);
    }
  };

  const erroresCampo = error instanceof ErrorApi ? error.erroresPorCampo : {};

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Proyectos solares</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Cada proyecto se organiza en grupos de inversores, administra su tarifa
            <strong> trimestral</strong> de kWh y su proyeccion anual repartida mes a mes.
          </p>
        </div>
        {gestionar ? (
          <button type="button" className="boton" onClick={abrirAlta}>
            Nuevo proyecto
          </button>
        ) : null}
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error && !formulario ? <MensajeError error={error} /> : null}

      <section className="tarjeta">
        <div className="filtros no-imprimir">
          <CampoTexto
            etiqueta="Buscar"
            type="search"
            placeholder="Proyecto, ubicacion o cliente"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Cliente"
            value={String(listado.estado.id_cliente ?? '')}
            onChange={(e) => listado.actualizar({ id_cliente: e.target.value })}
          >
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Modalidad comercial"
            value={String(listado.estado.tipo_proyecto ?? '')}
            onChange={(e) => listado.actualizar({ tipo_proyecto: e.target.value })}
          >
            <option value="">Todas</option>
            <option value="PPA">PPA</option>
            <option value="EPC">EPC</option>
            <option value="EDS">EDS</option>
          </CampoSelect>
          <CampoSelect
            etiqueta="Estado"
            value={String(listado.estado.activo ?? '')}
            onChange={(e) => listado.actualizar({ activo: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="1">Activos</option>
            <option value="0">Inactivos</option>
          </CampoSelect>
        </div>

        <Tabla<Proyecto>
          titulo="Listado de proyectos"
          descripcion="La produccion acumulada se muestra separada por nivel de detalle para evitar el doble conteo."
          columnas={[
            {
              clave: 'nombre',
              titulo: 'Proyecto',
              orden: 'nombre',
              render: (f) => <Link to={`/proyectos/${f.id_proyecto}`}>{f.nombre}</Link>,
            },
            { clave: 'cliente', titulo: 'Cliente', orden: 'cliente', render: (f) => f.cliente },
            {
              clave: 'tipo',
              titulo: 'Modalidad',
              orden: 'tipo',
              render: (f) => <span className="etiqueta etiqueta--azul">{f.tipo_proyecto}</span>,
            },
            { clave: 'kwp', titulo: 'Potencia', numerica: true, render: (f) => kwp(f.capacidad_kwp) },
            { clave: 'inv', titulo: 'Inversores', numerica: true, render: (f) => String(f.inversores) },
            {
              clave: 'produccion',
              titulo: 'Produccion acumulada',
              numerica: true,
              render: (f) => (
                <span>
                  {kwh(Number(f.kwh_por_inversor) + Number(f.kwh_consolidado))}
                  {Number(f.kwh_por_inversor) > 0 && Number(f.kwh_consolidado) > 0 ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.3rem' }}>
                      Dos niveles
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              clave: 'valor',
              titulo: 'Valor acumulado',
              numerica: true,
              render: (f) => (
                <span>
                  {quetzales(f.valor_q_total)}
                  {f.registros_pendientes > 0 ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.3rem' }}>
                      {f.registros_pendientes} pendiente(s)
                    </span>
                  ) : null}
                </span>
              ),
            },
            { clave: 'ultima', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_produccion) },
            {
              clave: 'estado',
              titulo: 'Estado',
              render: (f) => (
                <span className={f.activo ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--gris'}>
                  {f.activo ? 'Activo' : 'Inactivo'}
                </span>
              ),
            },
            {
              clave: 'acciones',
              titulo: 'Acciones',
              render: (f) => (
                <div className="acciones no-imprimir">
                  <Link className="boton boton--secundario boton--pequeno" to={`/proyectos/${f.id_proyecto}`}>
                    Detalle
                  </Link>
                  {gestionar ? (
                    <>
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => {
                          setEditando(f.id_proyecto);
                          setError(null);
                          setPaso(1);
                          setFormulario({
                            id_cliente: String(f.id_cliente),
                            nombre: f.nombre,
                            ubicacion: f.ubicacion ?? '',
                            tipo_proyecto: f.tipo_proyecto,
                            capacidad_kwp: f.capacidad_kwp === null ? '' : String(f.capacidad_kwp),
                            fecha_inicio: f.fecha_inicio?.slice(0, 10) ?? '',
                            observaciones: '',
                            activo: Boolean(f.activo),
                          });
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="boton boton--peligro boton--pequeno"
                        onClick={() => setAEliminar(f)}
                      >
                        Baja
                      </button>
                    </>
                  ) : null}
                </div>
              ),
            },
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_proyecto}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay proyectos registrados"
          vacioDescripcion="Registre primero un cliente y luego su proyecto solar."
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {formulario ? (
        <Modal
          titulo={editando ? 'Editar proyecto' : `Nuevo proyecto solar - paso ${paso} de 3`}
          alCerrar={cerrarFormulario}
        >
          {error ? <MensajeError error={error} /> : null}

          {/* Guia de pasos del alta. En la edicion no aplica. */}
          {!editando ? (
            <ol className="pasos" aria-label="Pasos del alta del proyecto">
              {PASOS.map((p) => (
                <li key={p.numero} aria-current={p.numero === paso ? 'step' : undefined}>
                  <span className="pasos__numero">{p.numero}</span>
                  {p.titulo}
                </li>
              ))}
            </ol>
          ) : null}

          <form onSubmit={guardar} noValidate>
            {/* ---------------------------------------------------------- */}
            {/* Paso 1: datos generales                                     */}
            {/* ---------------------------------------------------------- */}
            {paso === 1 ? (
              <>
                <MensajeInfo>
                  La <strong>modalidad comercial</strong> puede ser PPA, EPC o EDS. La{' '}
                  <strong>potencia instalada se expresa en kWp</strong>;
                  la energia generada se registra aparte en kWh.
                </MensajeInfo>
                <div className="formulario">
                  <CampoSelect
                    etiqueta="Cliente propietario"
                    obligatorio
                    value={formulario.id_cliente}
                    error={erroresCampo.id_cliente}
                    ayuda="Un proyecto no puede existir sin cliente."
                    onChange={(e) => setFormulario({ ...formulario, id_cliente: e.target.value })}
                  >
                    <option value="">Seleccione un cliente</option>
                    {catalogos.clientes.map((c) => (
                      <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
                    ))}
                  </CampoSelect>
                  <CampoTexto
                    etiqueta="Nombre del proyecto (planta)"
                    obligatorio
                    value={formulario.nombre}
                    error={erroresCampo.nombre}
                    ayuda="Debe coincidir con la columna Planta de los archivos historicos."
                    onChange={(e) => setFormulario({ ...formulario, nombre: e.target.value })}
                  />
                  <CampoSelect
                    etiqueta="Modalidad comercial"
                    value={formulario.tipo_proyecto}
                    onChange={(e) => setFormulario({ ...formulario, tipo_proyecto: e.target.value })}
                  >
                    <option value="PPA">PPA</option>
                    <option value="EPC">EPC</option>
                    <option value="EDS">EDS</option>
                  </CampoSelect>
                  <CampoTexto
                    etiqueta="Ubicacion"
                    value={formulario.ubicacion}
                    onChange={(e) => setFormulario({ ...formulario, ubicacion: e.target.value })}
                  />
                  <CampoTexto
                    etiqueta="Potencia instalada (kWp)"
                    type="number"
                    min="0"
                    step="0.001"
                    value={formulario.capacidad_kwp}
                    error={erroresCampo.capacidad_kwp}
                    ayuda="Solo potencia. Nunca se registra aqui la generacion acumulada."
                    onChange={(e) => setFormulario({ ...formulario, capacidad_kwp: e.target.value })}
                  />
                  <CampoTexto
                    etiqueta="Fecha de inicio de operacion"
                    type="date"
                    value={formulario.fecha_inicio}
                    onChange={(e) => setFormulario({ ...formulario, fecha_inicio: e.target.value })}
                  />
                  <CampoTexto
                    etiqueta="Observaciones"
                    ancho
                    value={formulario.observaciones}
                    onChange={(e) => setFormulario({ ...formulario, observaciones: e.target.value })}
                  />
                  <CampoCasilla
                    etiqueta="Proyecto activo"
                    ancho
                    checked={formulario.activo}
                    onChange={(e) => setFormulario({ ...formulario, activo: e.target.checked })}
                  />
                </div>
              </>
            ) : null}

            {/* ---------------------------------------------------------- */}
            {/* Paso 2: proyeccion anual repartida mes a mes                */}
            {/* ---------------------------------------------------------- */}
            {paso === 2 ? (
              <>
                <MensajeInfo titulo="Proyeccion pactada">
                  La proyeccion anual se captura <strong>al crear el proyecto</strong> y es la base
                  contra la que despues se compara la produccion real para saber si la planta cumple
                  lo pactado. Reparta el compromiso anual entre los 12 meses, en kWh.
                </MensajeInfo>
                <div className="formulario">
                  <CampoTexto
                    etiqueta="Año de la proyeccion"
                    type="number"
                    min="2000"
                    max="2100"
                    value={String(anioProyeccion)}
                    onChange={(e) => setAnioProyeccion(Number(e.target.value))}
                  />
                  <CampoTexto
                    etiqueta="Repartir un total anual en partes iguales"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Ej. 144000"
                    ayuda="Atajo opcional: escriba el total y presione Repartir para llenar los 12 meses."
                    id="total-anual-atajo"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const valor = Number((e.target as HTMLInputElement).value);
                        if (valor > 0) repartirAnual(valor);
                      }
                    }}
                  />
                  <div className="campo">
                    <span className="campo__ayuda">&nbsp;</span>
                    <button
                      type="button"
                      className="boton boton--secundario"
                      onClick={() => {
                        const campo = document.getElementById(
                          'total-anual-atajo',
                        ) as HTMLInputElement | null;
                        const valor = Number(campo?.value ?? 0);
                        if (valor > 0) repartirAnual(valor);
                      }}
                    >
                      Repartir en 12 meses
                    </button>
                  </div>
                </div>

                <div className="formulario formulario--meses">
                  {mesesProyeccion.map((valor, indice) => (
                    <CampoTexto
                      key={indice}
                      etiqueta={nombreMes(indice + 1)}
                      type="number"
                      min="0"
                      step="0.01"
                      obligatorio
                      value={valor}
                      onChange={(e) => {
                        const copia = [...mesesProyeccion];
                        copia[indice] = e.target.value;
                        setMesesProyeccion(copia);
                      }}
                    />
                  ))}
                </div>

                <p className="resumen-linea">
                  Total anual proyectado: <strong>{kwh(totalProyectado)}</strong>
                  {mesesIncompletos ? (
                    <span className="etiqueta etiqueta--ambar" style={{ marginLeft: '0.4rem' }}>
                      Faltan meses por capturar
                    </span>
                  ) : null}
                </p>
              </>
            ) : null}

            {/* ---------------------------------------------------------- */}
            {/* Paso 3: grupos de inversores                                */}
            {/* ---------------------------------------------------------- */}
            {paso === 3 ? (
              <>
                <MensajeInfo titulo="Jerarquia del proyecto">
                  Un proyecto se divide en <strong>grupos</strong> y cada grupo agrupa varios{' '}
                  <strong>inversores</strong> con sus seriales. Declare aqui cuantos inversores
                  llevara cada grupo y si cuenta con banco de baterias. Los inversores se registran
                  despues, desde la pantalla de inversores. Puede dejar esta lista vacia y crear los
                  grupos mas adelante.
                </MensajeInfo>

                {gruposNuevos.map((grupo, indice) => (
                  <fieldset key={indice} className="grupo-alta">
                    <legend>Grupo {indice + 1}</legend>
                    <div className="formulario">
                      <CampoTexto
                        etiqueta="Nombre del grupo"
                        placeholder="Ej. Bloque A - Campo norte"
                        value={grupo.nombre}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = { ...grupo, nombre: e.target.value };
                          setGruposNuevos(copia);
                        }}
                      />
                      <CampoTexto
                        etiqueta="Cantidad de inversores"
                        type="number"
                        min="0"
                        step="1"
                        ayuda="Cuantos equipos llevara el grupo. El sistema avisa si faltan por registrar."
                        value={grupo.cantidad_inversores_declarada}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = {
                            ...grupo,
                            cantidad_inversores_declarada: e.target.value,
                          };
                          setGruposNuevos(copia);
                        }}
                      />
                      <CampoTexto
                        etiqueta="Potencia del grupo (kWp)"
                        type="number"
                        min="0"
                        step="0.001"
                        value={grupo.capacidad_kwp}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = { ...grupo, capacidad_kwp: e.target.value };
                          setGruposNuevos(copia);
                        }}
                      />
                      <CampoTexto
                        etiqueta="Ubicacion del grupo"
                        value={grupo.ubicacion}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = { ...grupo, ubicacion: e.target.value };
                          setGruposNuevos(copia);
                        }}
                      />
                      <CampoCasilla
                        etiqueta="Cuenta con banco de baterias"
                        checked={grupo.tiene_banco_baterias}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = {
                            ...grupo,
                            tiene_banco_baterias: e.target.checked,
                            capacidad_baterias_kwh: e.target.checked
                              ? grupo.capacidad_baterias_kwh
                              : '',
                          };
                          setGruposNuevos(copia);
                        }}
                      />
                      <CampoTexto
                        etiqueta="Capacidad del banco (kWh)"
                        type="number"
                        min="0"
                        step="0.01"
                        disabled={!grupo.tiene_banco_baterias}
                        value={grupo.capacidad_baterias_kwh}
                        onChange={(e) => {
                          const copia = [...gruposNuevos];
                          copia[indice] = { ...grupo, capacidad_baterias_kwh: e.target.value };
                          setGruposNuevos(copia);
                        }}
                      />
                    </div>
                    {gruposNuevos.length > 1 ? (
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno"
                        onClick={() => setGruposNuevos(gruposNuevos.filter((_, i) => i !== indice))}
                      >
                        Quitar este grupo
                      </button>
                    ) : null}
                  </fieldset>
                ))}

                <button
                  type="button"
                  className="boton boton--secundario"
                  onClick={() => setGruposNuevos([...gruposNuevos, { ...GRUPO_VACIO }])}
                >
                  Agregar otro grupo
                </button>

                <p className="resumen-linea" style={{ marginTop: '0.9rem' }}>
                  Se crearan <strong>{gruposConNombre.length} grupo(s)</strong> con un total
                  declarado de{' '}
                  <strong>
                    {numero(
                      gruposConNombre.reduce(
                        (a, g) => a + Number(g.cantidad_inversores_declarada || 0),
                        0,
                      ),
                      0,
                    )}
                  </strong>{' '}
                  inversor(es), junto con la proyeccion de {kwh(totalProyectado)} para{' '}
                  {anioProyeccion}.
                </p>
              </>
            ) : null}

            {errorDelPaso() ? <MensajeAlerta>{errorDelPaso()}</MensajeAlerta> : null}

            <div className="acciones" style={{ marginTop: '1.1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={cerrarFormulario}>
                Cancelar
              </button>
              {!editando && paso > 1 ? (
                <button
                  type="button"
                  className="boton boton--secundario"
                  onClick={() => setPaso(paso - 1)}
                >
                  Anterior
                </button>
              ) : null}
              {!editando && paso < 3 ? (
                <button
                  key="siguiente"
                  type="button"
                  className="boton"
                  disabled={Boolean(errorDelPaso())}
                  onClick={() => setPaso(paso + 1)}
                >
                  Siguiente
                </button>
              ) : (
                <button
                  key="finalizar"
                  type="submit"
                  className="boton"
                  disabled={ocupado || Boolean(errorDelPaso())}
                >
                  {ocupado ? 'Guardando...' : editando ? 'Guardar proyecto' : 'Crear proyecto'}
                </button>
              )}
            </div>
          </form>
        </Modal>
      ) : null}

      {aEliminar ? (
        <Confirmacion
          titulo="Dar de baja el proyecto"
          peligroso
          ocupado={ocupado}
          textoConfirmar="Continuar"
          descripcion={
            <p>
              Si <strong>{aEliminar.nombre}</strong> tiene inversores o produccion registrada, el sistema lo
              desactivara en lugar de eliminarlo, para conservar el historico energetico y su auditoria.
            </p>
          }
          alConfirmar={eliminar}
          alCancelar={() => setAEliminar(null)}
        />
      ) : null}
    </>
  );
}
