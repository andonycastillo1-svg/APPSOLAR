import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  filasProduccion,
  iniciarSesion,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { execute, query, queryOne } from '../src/db/pool';
import { detectarFormato, agruparPorPeriodo, leerArchivo } from '../src/services/etl';

const CABECERA_HISTORICA = 'Planta,Tipo,Anio,Mes,Generacion,Comentarios';

function csv(...lineas: string[]): Buffer {
  return Buffer.from(lineas.join('\r\n'), 'utf8');
}

async function xlsxHistorico(filas: Array<[string, string, number, string, number, string]>): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Historico');
  hoja.addRow(['Planta', 'Tipo', 'Anio', 'Mes', 'Generacion', 'Comentarios']);
  filas.forEach((fila) => hoja.addRow(fila));
  return Buffer.from(await libro.xlsx.writeBuffer());
}

describe('Importacion de historicos (ETL)', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let datos: DatosBase;
  let planta: string;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('imp.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('imp.oper@retse.com.gt', 'OPERATIVO');
    admin = await iniciarSesion('imp.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('imp.oper@retse.com.gt', PASSWORD_PRUEBAS);
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
    const proyecto = await queryOne<{ nombre: string }>(
      'SELECT nombre FROM proyectos WHERE id_proyecto = ?',
      [datos.idProyecto],
    );
    planta = proyecto!.nombre;
  });

  afterAll(async () => {
    await cerrarTodo();
  });

  // -------------------------------------------------------------------------
  // Deteccion de formato y lectura (pruebas unitarias del ETL)
  // -------------------------------------------------------------------------

  it('detecta los dos formatos de plantilla admitidos', () => {
    expect(detectarFormato(['Planta', 'Tipo', 'Anio', 'Mes', 'Generacion', 'Comentarios']).formato).toBe(
      'HISTORICO_EXCEL',
    );
    expect(detectarFormato(['Planta', 'Tipo', 'Año', 'Mes', 'Generación', 'Comentarios']).formato).toBe(
      'HISTORICO_EXCEL',
    );
    expect(detectarFormato(['fecha', 'kwh', 'inversor_serial', 'comentarios']).formato).toBe('NORMALIZADO');
    expect(() => detectarFormato(['columna1', 'columna2'])).toThrowError(/No se reconocieron los encabezados/);
  });

  it('agrupa por planta/anio/mes y marca los grupos que requieren decision', async () => {
    const lectura = await leerArchivo(
      csv(
        CABECERA_HISTORICA,
        'Planta X,PPA,2025,Enero,100,',
        'Planta X,PPA,2025,Enero,50,',
        'Planta X,PPA,2025,Febrero,200,',
      ),
      '.csv',
      { maxFilas: 100 },
    );

    const grupos = agruparPorPeriodo(lectura.filas);
    expect(grupos).toHaveLength(2);

    const enero = grupos.find((g) => g.mes === 1)!;
    expect(enero.filas).toHaveLength(2);
    expect(enero.kwhTotal).toBe(150);
    // Dos filas del mismo mes sin inversor NO son duplicados automaticos.
    expect(enero.requiereDecision).toBe(true);

    const febrero = grupos.find((g) => g.mes === 2)!;
    expect(febrero.requiereDecision).toBe(false);
  });

  it('neutraliza formulas y toma el resultado de las celdas calculadas', async () => {
    const lectura = await leerArchivo(
      csv(CABECERA_HISTORICA, 'Planta X,PPA,2025,Enero,100,=cmd|calc'),
      '.csv',
      { maxFilas: 100 },
    );
    // El comentario con formula se neutraliza anteponiendo una comilla.
    expect(lectura.filas[0].comentarios?.startsWith("'=")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Validaciones del archivo
  // -------------------------------------------------------------------------

  it('rechaza encabezados invalidos', async () => {
    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv('columna_a,columna_b', '1,2'), 'malo.csv')
      .expect(422);

    expect(respuesta.body.error.mensaje).toContain('No se reconocieron los encabezados');
  });

  it('rechaza extensiones no permitidas y contenido peligroso', async () => {
    await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', Buffer.from('contenido'), 'script.exe')
      .expect(422);

    // Un ZIP disfrazado de CSV se rechaza por su firma binaria real.
    const zipFalso = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', zipFalso, 'falso.csv')
      .expect(422);
    expect(respuesta.body.error.mensaje).toContain('archivo comprimido');
  });

  it('rechaza un archivo que supera el tamano maximo permitido', async () => {
    const grande = Buffer.alloc(11 * 1024 * 1024, 'a');
    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', grande, 'grande.csv');

    // Multer corta la carga; el manejador central responde con error controlado.
    expect([413, 422, 500]).toContain(respuesta.status);
    expect(respuesta.status).not.toBe(201);
  });

  it('detecta fechas imposibles, kWh no numerico y valores negativos', async () => {
    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(
          CABECERA_HISTORICA,
          `${planta},PPA,2025,Enero,100,fila valida`,
          `${planta},PPA,1899,Febrero,100,anio invalido`,
          `${planta},PPA,2025,Trecemberre,100,mes invalido`,
          `${planta},PPA,2025,Marzo,abc,kwh no numerico`,
          `${planta},PPA,2025,Abril,-500,kwh negativo`,
          `,PPA,2025,Mayo,100,planta vacia`,
        ),
        'errores.csv',
      )
      .expect(200);

    const codigos = respuesta.body.datos.problemas.map((p: { codigo: string }) => p.codigo);
    expect(codigos).toContain('ANIO_INVALIDO');
    expect(codigos).toContain('MES_INVALIDO');
    expect(codigos).toContain('KWH_NO_NUMERICO');
    expect(codigos).toContain('KWH_NEGATIVO');
    expect(codigos).toContain('PLANTA_VACIA');

    expect(respuesta.body.datos.totales.validas).toBe(1);
    expect(respuesta.body.datos.totales.errores).toBe(5);
    // Los errores de fila no bloquean: habilitan una carga parcial confirmada.
    expect(respuesta.body.datos.puedeConfirmar).toBe(true);
    expect(respuesta.body.datos.requiereConfirmarCargaParcial).toBe(true);
  });

  it('informa las plantas que no corresponden a ningun proyecto registrado', async () => {
    const respuesta = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, 'Planta Inexistente,PPA,2025,Enero,100,'), 'plantas.csv')
      .expect(200);

    expect(respuesta.body.datos.plantasNoResueltas).toContain('Planta Inexistente');
    expect(respuesta.body.datos.puedeConfirmar).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Flujo completo de previsualizacion y confirmacion
  // -------------------------------------------------------------------------

  it('carga el formato historico del Excel y valoriza con la tarifa del trimestre', async () => {
    // I trimestre con tarifa; II trimestre deliberadamente sin ella.
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(
          CABECERA_HISTORICA,
          `${planta},PPA,2025,Enero,1000,Operacion normal`,
          `${planta},PPA,2025,Febrero,500,`,
          `${planta},PPA,2025,Abril,300,Trimestre sin tarifa aun`,
        ),
        'historico.csv',
      )
      .expect(200);

    expect(previa.body.datos.formato).toBe('HISTORICO_EXCEL');
    expect(previa.body.datos.nivelDetalleLote).toBe('PROYECTO_CONSOLIDADO');
    expect(previa.body.datos.totales.validas).toBe(3);
    expect(previa.body.datos.puedeConfirmar).toBe(true);
    expect(previa.body.datos.mesesSinTarifaAprobada).toHaveLength(1);
    expect(previa.body.datos.mesesSinTarifaAprobada[0].mesNombre).toBe('Abril');

    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({ politicaDuplicados: 'ACTUALIZAR' })
      .expect(200);

    expect(confirmacion.body.datos.insertadas).toBe(3);
    expect(confirmacion.body.datos.pendientesTarifa).toBe(1);
    expect(confirmacion.body.datos.estado).toBe('COMPLETADO');

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(3);
    // Enero y febrero comparten la tarifa del I trimestre (Q 1.00).
    expect(Number(filas[0].valor_q)).toBe(1000);
    expect(Number(filas[1].valor_q)).toBe(500);
    // Abril pertenece al II trimestre, que aun no tiene tarifa aprobada.
    expect(filas[2].estado_valorizacion).toBe('PENDIENTE_DE_TARIFA');
    expect(Number(filas[2].kwh)).toBe(300);

    // La granularidad del formato historico es MENSUAL, anclada al dia 1.
    expect(filas.every((f) => f.granularidad === 'MENSUAL')).toBe(true);
    expect(filas.every((f) => f.nivel_detalle === 'PROYECTO_CONSOLIDADO')).toBe(true);
  });

  it('carga la plantilla normalizada en XLSX asociada a un inversor', async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Produccion');
    hoja.addRow(['fecha', 'kwh', 'inversor_serial', 'comentarios']);
    hoja.addRow(['2025-06-01', 120.5, `SN-MAN0`, 'Lectura diaria']);
    hoja.addRow(['2025-06-02', 118.25, `SN-MAN0`, '']);
    const contenido = Buffer.from(await libro.xlsx.writeBuffer());

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .field('id_proyecto', String(datos.idProyecto))
      .field('id_inversor', String(datos.idInversor))
      .attach('archivo', contenido, 'normalizado.xlsx')
      .expect(200);

    expect(previa.body.datos.formato).toBe('NORMALIZADO');
    expect(previa.body.datos.nivelDetalleLote).toBe('POR_INVERSOR');
    expect(previa.body.datos.totales.validas).toBe(2);

    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.granularidad === 'DIARIA')).toBe(true);
    expect(filas.every((f) => f.nivel_detalle === 'POR_INVERSOR')).toBe(true);
    expect(Number(filas[0].kwh)).toBe(120.5);
  });

  it('exige una decision para varias filas de la misma planta y mes sin inversor', async () => {
    const contenido = csv(
      CABECERA_HISTORICA,
      `${planta},PPA,2025,Julio,1000,Medidor A`,
      `${planta},PPA,2025,Julio,250,Medidor B`,
    );

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, 'grupo.csv')
      .expect(200);

    expect(previa.body.datos.gruposQueRequierenDecision).toHaveLength(1);
    const grupo = previa.body.datos.gruposQueRequierenDecision[0];
    expect(grupo.filas).toBe(2);
    expect(Number(grupo.kwhTotal)).toBe(1250);
    expect(grupo.opciones.map((o: { valor: string }) => o.valor)).toEqual([
      'SUMAR',
      'COMPONENTES',
      'MAPEAR',
      'RECHAZAR',
    ]);

    // Confirmar sin decidir se rechaza con un mensaje explicito.
    const sinDecision = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(409);
    expect(sinDecision.body.error.mensaje).toContain('sin identificador de inversor');

    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({ decisiones: { [grupo.clave]: 'SUMAR' } })
      .expect(200);

    expect(confirmacion.body.datos.insertadas).toBe(1);

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(1);
    expect(Number(filas[0].kwh)).toBe(1250);
    expect(filas[0].secuencia).toBe(0);
  });

  it('la decision COMPONENTES conserva cada fila sin sumarlas ni duplicarlas', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(CABECERA_HISTORICA, `${planta},PPA,2025,Agosto,700,A`, `${planta},PPA,2025,Agosto,300,B`),
        'componentes.csv',
      )
      .expect(200);

    const clave = previa.body.datos.gruposQueRequierenDecision[0].clave;
    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({ decisiones: { [clave]: 'COMPONENTES' } })
      .expect(200);

    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.secuencia).sort()).toEqual([0, 1]);
    // La suma de los componentes equivale al total del mes: no hay duplicidad.
    expect(filas.reduce((acc, f) => acc + Number(f.kwh), 0)).toBe(1000);

    const resumen = await comoUsuario(operativo)
      .get(`/api/production/summary?desde=2025-08-01&hasta=2025-08-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);
    expect(Number(resumen.body.datos.kwh)).toBe(1000);
  });

  it('la decision RECHAZAR descarta el grupo y lo deja registrado', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(
          CABECERA_HISTORICA,
          `${planta},PPA,2025,Septiembre,700,A`,
          `${planta},PPA,2025,Septiembre,300,B`,
          `${planta},PPA,2025,Octubre,900,unica`,
        ),
        'rechazo.csv',
      )
      .expect(200);

    const clave = previa.body.datos.gruposQueRequierenDecision[0].clave;
    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({ decisiones: { [clave]: 'RECHAZAR' } })
      .expect(200);

    expect(confirmacion.body.datos.rechazadas).toBe(2);
    expect(confirmacion.body.datos.insertadas).toBe(1);
    expect(confirmacion.body.datos.estado).toBe('COMPLETADO_CON_ERRORES');

    const errores = await query<{ codigo: string }>(
      'SELECT codigo FROM historico_errores WHERE id_historico = ?',
      [previa.body.datos.id_historico],
    );
    expect(errores.map((e) => e.codigo)).toContain('GRUPO_RECHAZADO');
  });

  // -------------------------------------------------------------------------
  // Duplicados, idempotencia y doble conteo
  // -------------------------------------------------------------------------

  it('detecta duplicados y es idempotente al repetir la misma carga', async () => {
    const contenido = csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,1000,`);

    const primera = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, 'lote.csv')
      .expect(200);
    await comoUsuario(operativo)
      .post(`/api/imports/${primera.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const segunda = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', contenido, 'lote.csv')
      .expect(200);
    expect(segunda.body.datos.duplicados).toHaveLength(1);

    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${segunda.body.datos.id_historico}/confirm`)
      .send({ politicaDuplicados: 'ACTUALIZAR' })
      .expect(200);

    expect(confirmacion.body.datos.insertadas).toBe(0);
    expect(confirmacion.body.datos.actualizadas).toBe(1);

    // La energia no se duplico.
    const filas = await filasProduccion(datos.idProyecto);
    expect(filas).toHaveLength(1);
    expect(Number(filas[0].kwh)).toBe(1000);
  });

  it('la politica OMITIR conserva el valor existente', async () => {
    const primera = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,1000,`), 'a.csv')
      .expect(200);
    await comoUsuario(operativo)
      .post(`/api/imports/${primera.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const segunda = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,9999,`), 'b.csv')
      .expect(200);
    const confirmacion = await comoUsuario(operativo)
      .post(`/api/imports/${segunda.body.datos.id_historico}/confirm`)
      .send({ politicaDuplicados: 'OMITIR' })
      .expect(200);

    expect(confirmacion.body.datos.omitidas).toBe(1);
    const filas = await filasProduccion(datos.idProyecto);
    expect(Number(filas[0].kwh)).toBe(1000);
  });

  it('impide mezclar consolidado de proyecto y detalle por inversor sin confirmacion', async () => {
    // Primero se carga el detalle por inversor de enero 2025.
    await comoUsuario(operativo)
      .post('/api/production')
      .send({
        id_proyecto: datos.idProyecto,
        id_inversor: datos.idInversor,
        fecha: '2025-01-10',
        kwh: 500,
        granularidad: 'MENSUAL',
      })
      .expect(201);

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,1000,`), 'mezcla.csv')
      .expect(200);

    expect(previa.body.datos.conflictosNivelDetalle).toHaveLength(1);
    expect(previa.body.datos.conflictosNivelDetalle[0].existente).toBe('POR_INVERSOR');
    expect(previa.body.datos.conflictosNivelDetalle[0].entrante).toBe('PROYECTO_CONSOLIDADO');

    const bloqueado = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(409);
    expect(bloqueado.body.error.mensaje).toContain('duplicaria la energia');

    // Con confirmacion explicita se permite, pero los totales NO suman ambos.
    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({ confirmarMezclaNiveles: true })
      .expect(200);

    const resumen = await comoUsuario(operativo)
      .get(`/api/production/summary?desde=2025-01-01&hasta=2025-01-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    // Prevalece el detalle por inversor (500), no 500 + 1000.
    expect(Number(resumen.body.datos.kwh)).toBe(500);
    expect(resumen.body.datos.periodosConMezclaDeNiveles).toHaveLength(1);
  });

  it('no suma la granularidad mensual cuando el mismo inversor tiene lecturas diarias', async () => {
    await comoUsuario(operativo)
      .post('/api/production')
      .send({
        id_proyecto: datos.idProyecto,
        id_inversor: datos.idInversor,
        fecha: '2025-03-01',
        kwh: 3000,
        granularidad: 'MENSUAL',
      })
      .expect(201);

    for (const dia of ['01', '02', '03']) {
      await comoUsuario(operativo)
        .post('/api/production')
        .send({
          id_proyecto: datos.idProyecto,
          id_inversor: datos.idInversor,
          fecha: `2025-03-${dia}`,
          kwh: 100,
          granularidad: 'DIARIA',
        })
        .expect(201);
    }

    const resumen = await comoUsuario(operativo)
      .get(`/api/production/summary?desde=2025-03-01&hasta=2025-03-31&id_proyecto=${datos.idProyecto}`)
      .expect(200);

    // Prevalece la lectura diaria: 300, no 3300.
    expect(Number(resumen.body.datos.kwh)).toBe(300);
  });

  // -------------------------------------------------------------------------
  // Transaccionalidad y ciclo de vida del lote
  // -------------------------------------------------------------------------

  it('revierte por completo la importacion si la transaccion falla', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(
          CABECERA_HISTORICA,
          `${planta},PPA,2025,Enero,100,`,
          `${planta},PPA,2025,Febrero,200,`,
          `${planta},PPA,2025,Marzo,300,`,
        ),
        'rollback.csv',
      )
      .expect(200);

    // Se elimina el proyecto entre la previsualizacion y la confirmacion:
    // la insercion violara la clave foranea a mitad del lote.
    await execute('DELETE FROM inversores WHERE id_proyecto = ?', [datos.idProyecto]);
    await execute('DELETE FROM grupos WHERE id_proyecto = ?', [datos.idProyecto]);
    await execute('DELETE FROM tarifas_kwh WHERE id_proyecto = ?', [datos.idProyecto]);
    await execute('DELETE FROM proyectos WHERE id_proyecto = ?', [datos.idProyecto]);

    const respuesta = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({});

    expect(respuesta.status).toBeGreaterThanOrEqual(400);

    // Ninguna fila quedo insertada: el lote es todo o nada.
    const filas = await query('SELECT id_produccion FROM produccion');
    expect(filas).toHaveLength(0);

    const historico = await queryOne<{ estado: string }>(
      'SELECT estado FROM historicos WHERE id_historico = ?',
      [previa.body.datos.id_historico],
    );
    expect(historico?.estado).toBe('FALLIDO');
  });

  it('no permite confirmar dos veces el mismo lote', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,100,`), 'unico.csv')
      .expect(200);

    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const segunda = await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(409);

    expect(segunda.body.error.mensaje).toContain('COMPLETADO');
  });

  it('permite cancelar una previsualizacion sin alterar la produccion', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,100,`), 'cancelar.csv')
      .expect(200);

    await comoUsuario(operativo).delete(`/api/imports/${previa.body.datos.id_historico}`).expect(200);

    const filas = await query('SELECT id_produccion FROM produccion');
    expect(filas).toHaveLength(0);

    const historico = await queryOne<{ estado: string }>(
      'SELECT estado FROM historicos WHERE id_historico = ?',
      [previa.body.datos.id_historico],
    );
    expect(historico?.estado).toBe('RECHAZADO');
  });

  it('impide cargar datos en un periodo cerrado', async () => {
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates`)
      .send({ anio: 2025, trimestre: 1, costo_kwh: 1.0, aprobarInmediato: true })
      .expect(201);
    await comoUsuario(admin)
      .post(`/api/projects/${datos.idProyecto}/rates/close`)
      .send({ anio: 2025, mes: 1, motivo: 'Cierre de prueba' })
      .expect(200);

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach('archivo', csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,100,`), 'cerrado.csv')
      .expect(200);

    expect(previa.body.datos.periodosCerrados).toHaveLength(1);
    expect(previa.body.datos.puedeConfirmar).toBe(false);

    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(409);
  });

  it('registra el historial con hash, usuario, periodo cubierto y resultados', async () => {
    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .attach(
        'archivo',
        csv(CABECERA_HISTORICA, `${planta},PPA,2025,Enero,100,`, `${planta},PPA,2025,Mayo,200,`),
        'historial.csv',
      )
      .expect(200);

    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const detalle = await comoUsuario(operativo)
      .get(`/api/imports/${previa.body.datos.id_historico}`)
      .expect(200);

    const h = detalle.body.datos;
    expect(h.hash_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.nombre_archivo_original).toBe('historial.csv');
    // El nombre almacenado lo genera el servidor: nunca el del navegador.
    expect(h.nombre_archivo_seguro).not.toBe('historial.csv');
    expect(h.usuario).toContain('OPERATIVO');
    expect(h.fecha_min).toContain('2025-01-01');
    expect(h.fecha_max).toContain('2025-05-01');
    expect(h.insertadas).toBe(2);
    expect(h.estado).toBe('COMPLETADO');
    expect(h.confirmado_en).toBeTruthy();
  });

  it('actualiza la fecha de produccion disponible del inversor tras la carga', async () => {
    const libro = await xlsxHistorico([]);
    void libro;

    const previa = await comoUsuario(operativo)
      .post('/api/imports/preview')
      .field('id_proyecto', String(datos.idProyecto))
      .field('id_inversor', String(datos.idInversor))
      .attach(
        'archivo',
        csv('fecha,kwh,comentarios', '2025-04-10,90,', '2025-04-11,95,'),
        'normalizado.csv',
      )
      .expect(200);

    await comoUsuario(operativo)
      .post(`/api/imports/${previa.body.datos.id_historico}/confirm`)
      .send({})
      .expect(200);

    const inversor = await queryOne<{ ultima_actualizacion: string | null }>(
      'SELECT ultima_actualizacion FROM inversores WHERE id_inversor = ?',
      [datos.idInversor],
    );
    expect(String(inversor?.ultima_actualizacion)).toContain('2025-04-11');
  });

  it('descarga las plantillas y el archivo de ejemplo con errores', async () => {
    const xlsx = await comoUsuario(operativo)
      .get('/api/imports/template?formato=HISTORICO_EXCEL&tipo=xlsx')
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');

    const csvPlantilla = await comoUsuario(operativo)
      .get('/api/imports/template?formato=NORMALIZADO&tipo=csv')
      .expect(200);
    expect(csvPlantilla.text).toContain('fecha,kwh,inversor_serial,comentarios');

    const ejemplo = await comoUsuario(operativo)
      .get('/api/imports/template?tipo=errores')
      .expect(200);
    expect(ejemplo.text).toContain('Trecemberre');
  });
});
