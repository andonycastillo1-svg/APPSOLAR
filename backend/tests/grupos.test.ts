import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearTarifaAprobada,
  crearUsuario,
  cuerpoAltaProyecto,
  filasProduccion,
  iniciarSesion,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';

/**
 * Jerarquia PROYECTO -> GRUPO -> INVERSOR, proyeccion obligatoria en el alta
 * y carga manual de rangos cuando el fabricante no entrega datos.
 */
describe('Grupos de inversores, proyeccion del alta y carga manual por rango', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let gerencial: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('gr.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('gr.oper@retse.com.gt', 'OPERATIVO');
    await crearUsuario('gr.ger@retse.com.gt', 'GERENCIAL');
    admin = await iniciarSesion('gr.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('gr.oper@retse.com.gt', PASSWORD_PRUEBAS);
    gerencial = await iniciarSesion('gr.ger@retse.com.gt', PASSWORD_PRUEBAS);

    await limpiarDatos();
    datos = await crearDatosBase();
  }, 120000);

  afterAll(async () => {
    await cerrarTodo();
  });

  // =========================================================================
  // Alta del proyecto: proyeccion anual obligatoria y grupos declarados
  // =========================================================================

  describe('alta del proyecto con su arbol y su proyeccion', () => {
    it('crea proyecto, proyeccion de 12 meses y grupos en una sola transaccion', async () => {
      const respuesta = await comoUsuario(admin)
        .post('/api/projects')
        .send(
          cuerpoAltaProyecto(datos.idCliente, 'Planta con arbol completo', {
            capacidad_kwp: 1200,
            grupos: [
              {
                nombre: 'Bloque norte',
                cantidad_inversores_declarada: 3,
                tiene_banco_baterias: true,
                capacidad_baterias_kwh: 500,
                capacidad_kwp: 700,
              },
              {
                nombre: 'Bloque sur',
                cantidad_inversores_declarada: 2,
                tiene_banco_baterias: false,
                capacidad_kwp: 500,
              },
            ],
          }),
        )
        .expect(201);

      const creado = respuesta.body.datos;
      expect(creado.grupos).toHaveLength(2);
      expect(creado.proyeccion.meses).toBe(12);
      expect(creado.proyeccion.total_kwh).toBe(12000);

      const grupos = await comoUsuario(gerencial)
        .get(`/api/projects/${creado.id_proyecto}/groups`)
        .expect(200);

      expect(grupos.body.datos).toHaveLength(2);
      expect(grupos.body.meta.totales.inversoresDeclarados).toBe(5);
      expect(grupos.body.meta.totales.inversoresRegistrados).toBe(0);
      expect(grupos.body.meta.totales.gruposConBaterias).toBe(1);
      expect(Number(grupos.body.meta.totales.capacidadBateriasKwh)).toBe(500);

      // El grupo avisa que aun le faltan equipos por registrar.
      const norte = grupos.body.datos.find((g: { nombre: string }) => g.nombre === 'Bloque norte');
      expect(norte.inversoresFaltantes).toBe(3);
      expect(norte.avisoInversores).toContain('3 inversor(es)');
    });

    it('rechaza el alta sin proyeccion anual completa', async () => {
      const sinProyeccion = await comoUsuario(admin)
        .post('/api/projects')
        .send({ id_cliente: datos.idCliente, nombre: 'Sin proyeccion', tipo_proyecto: 'PPA' })
        .expect(422);
      expect(JSON.stringify(sinProyeccion.body.error)).toMatch(/proyeccion/i);

      // Una proyeccion incompleta tampoco sirve como base de comparacion.
      await comoUsuario(admin)
        .post('/api/projects')
        .send({
          id_cliente: datos.idCliente,
          nombre: 'Proyeccion incompleta',
          tipo_proyecto: 'PPA',
          proyeccion: {
            anio: 2026,
            meses: [
              { mes: 1, proyeccion_kwh: 100 },
              { mes: 2, proyeccion_kwh: 100 },
            ],
          },
        })
        .expect(422);
    });

    it('rechaza un grupo con capacidad de baterias pero sin banco declarado', async () => {
      const respuesta = await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups`)
        .send({
          nombre: 'Grupo incoherente',
          tiene_banco_baterias: false,
          capacidad_baterias_kwh: 300,
        })
        .expect(422);

      expect(respuesta.body.error.mensaje).toContain('SIN banco');
    });

    it('impide dos grupos con el mismo nombre dentro de un proyecto', async () => {
      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups`)
        .send({ nombre: 'Bloque repetido', cantidad_inversores_declarada: 1 })
        .expect(201);

      const repetido = await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups`)
        .send({ nombre: 'Bloque repetido' })
        .expect(409);
      expect(repetido.body.error.mensaje).toContain('Ya existe un grupo');
    });

    it('el gerencial consulta grupos pero no puede crearlos', async () => {
      await comoUsuario(gerencial).get(`/api/projects/${datos.idProyecto}/groups`).expect(200);
      await comoUsuario(gerencial)
        .post(`/api/projects/${datos.idProyecto}/groups`)
        .send({ nombre: 'Grupo del gerencial' })
        .expect(403);
    });
  });

  // =========================================================================
  // Inversores dentro del grupo
  // =========================================================================

  describe('el inversor vive siempre dentro de un grupo', () => {
    it('exige el grupo al registrar un inversor', async () => {
      const respuesta = await comoUsuario(operativo)
        .post('/api/inverters')
        .send({ id_proyecto: datos.idProyecto, marca: 'SMA', modelo: 'Sin grupo' })
        .expect(422);
      expect(JSON.stringify(respuesta.body.error)).toMatch(/grupo/i);
    });

    it('rechaza un grupo que pertenece a otro proyecto', async () => {
      const otro = await crearDatosBase('-ajeno');
      const respuesta = await comoUsuario(operativo)
        .post('/api/inverters')
        .send({
          id_proyecto: datos.idProyecto,
          id_grupo: otro.idGrupo,
          marca: 'SMA',
          modelo: 'Grupo ajeno',
        })
        .expect(422);
      expect(respuesta.body.error.mensaje).toMatch(/grupo/i);
    });

    it('el detalle del grupo lista sus inversores y su produccion mensual', async () => {
      const detalle = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .expect(200);

      expect(detalle.body.datos.nombre).toContain('Grupo Pruebas');
      expect(detalle.body.datos.inversores.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(detalle.body.datos.produccionMensual)).toBe(true);
    });

    it('desactiva el grupo en lugar de borrarlo cuando tiene equipo asociado', async () => {
      const respuesta = await comoUsuario(operativo)
        .delete(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .expect(200);

      expect(respuesta.body.datos.eliminado).toBe(false);
      expect(respuesta.body.datos.mensaje).toContain('conservar el historico');

      // Se reactiva para el resto de las pruebas.
      await comoUsuario(operativo)
        .put(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .send({ activo: true })
        .expect(200);
    });
  });

  // =========================================================================
  // Carga manual por rango: el punto critico ante fallas de conexion
  // =========================================================================

  describe('carga manual de un rango cuando falla la conexion con el fabricante', () => {
    let idProyecto = 0;
    let idGrupoA = 0;
    let idGrupoB = 0;

    beforeAll(async () => {
      const alta = await comoUsuario(admin)
        .post('/api/projects')
        .send(
          cuerpoAltaProyecto(datos.idCliente, 'Planta con hueco de datos', {
            capacidad_kwp: 800,
            grupos: [
              { nombre: 'Grupo conectado', cantidad_inversores_declarada: 1 },
              { nombre: 'Grupo incomunicado', cantidad_inversores_declarada: 1 },
            ],
          }),
        )
        .expect(201);

      idProyecto = alta.body.datos.id_proyecto;
      [idGrupoA, idGrupoB] = alta.body.datos.grupos;

      // Tarifa del I trimestre de 2026 para poder valorizar la carga.
      await crearTarifaAprobada(idProyecto, 2026, 1, 2.0);
    }, 60000);

    it('detecta los dias sin datos de cada grupo', async () => {
      const huecos = await comoUsuario(operativo)
        .get(`/api/production/gaps?desde=2026-01-01&hasta=2026-01-05&id_proyecto=${idProyecto}`)
        .expect(200);

      expect(huecos.body.meta.gruposConHuecos).toBe(2);
      expect(huecos.body.meta.diasFaltantesTotales).toBe(10);
      expect(huecos.body.datos[0].dias_esperados).toBe(5);
      expect(huecos.body.datos[0].dias_con_datos).toBe(0);
      expect(huecos.body.meta.explicacion).toContain('sin esperar al fabricante');
    });

    it('distribuye el total capturado entre los dias del rango y lo valoriza', async () => {
      const carga = await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoB,
          desde: '2026-01-01',
          hasta: '2026-01-05',
          modo: 'TOTAL_DISTRIBUIDO',
          kwh: 1000,
          motivo: 'El enlace del grupo estuvo caido toda la semana.',
        })
        .expect(201);

      expect(carga.body.datos.dias).toBe(5);
      expect(Number(carga.body.datos.kwh_por_dia)).toBe(200);
      expect(carga.body.datos.insertados).toBe(5);
      expect(carga.body.datos.nivel_detalle).toBe('GRUPO_CONSOLIDADO');
      expect(carga.body.datos.pendientesTarifa).toBe(0);

      const resumen = await comoUsuario(operativo)
        .get(`/api/production/summary?desde=2026-01-01&hasta=2026-01-31&id_proyecto=${idProyecto}`)
        .expect(200);
      expect(Number(resumen.body.datos.kwh)).toBe(1000);
      expect(Number(resumen.body.datos.valor_q)).toBe(2000);

      // El hueco de ese grupo quedo cubierto.
      const huecos = await comoUsuario(operativo)
        .get(`/api/production/gaps?desde=2026-01-01&hasta=2026-01-05&id_proyecto=${idProyecto}`)
        .expect(200);
      expect(huecos.body.datos.map((h: { id_grupo: number }) => h.id_grupo)).not.toContain(idGrupoB);
    });

    it('exige un motivo y rechaza rangos invalidos o futuros', async () => {
      const sinMotivo = await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({ id_grupo: idGrupoA, desde: '2026-02-01', hasta: '2026-02-03', kwh: 300, motivo: 'corto' })
        .expect(422);
      expect(JSON.stringify(sinMotivo.body.error)).toContain('minimo 10');

      await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoA,
          desde: '2026-02-05',
          hasta: '2026-02-01',
          kwh: 300,
          motivo: 'Rango invertido a proposito para la prueba.',
        })
        .expect(422);

      await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoA,
          desde: '2099-01-01',
          hasta: '2099-01-02',
          kwh: 300,
          motivo: 'Fecha futura a proposito para la prueba.',
        })
        .expect(422);
    });

    it('es idempotente: no duplica dias ya cargados salvo que se pida sobrescribir', async () => {
      const repetida = await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoB,
          desde: '2026-01-01',
          hasta: '2026-01-05',
          modo: 'TOTAL_DISTRIBUIDO',
          kwh: 1000,
          motivo: 'Reintento de la misma carga para verificar idempotencia.',
        })
        .expect(201);

      expect(repetida.body.datos.insertados).toBe(0);
      expect(repetida.body.datos.omitidos).toBe(5);
      expect(repetida.body.datos.mensaje).toContain('sobrescribir');

      const corregida = await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoB,
          desde: '2026-01-01',
          hasta: '2026-01-05',
          modo: 'DIARIO_UNIFORME',
          kwh: 300,
          motivo: 'El fabricante confirmo cifras mayores a las estimadas.',
          sobrescribir: true,
        })
        .expect(201);

      expect(corregida.body.datos.actualizados).toBe(5);
      expect(corregida.body.datos.insertados).toBe(0);

      const resumen = await comoUsuario(operativo)
        .get(`/api/production/summary?desde=2026-01-01&hasta=2026-01-31&id_proyecto=${idProyecto}`)
        .expect(200);
      // 5 dias x 300 kWh, sin rastro de la carga anterior.
      expect(Number(resumen.body.datos.kwh)).toBe(1500);
    });

    it('bloquea mezclar un cierre mensual con relleno diario salvo confirmacion', async () => {
      // Cierre mensual del grupo conectado.
      await comoUsuario(operativo)
        .post('/api/production')
        .send({
          id_proyecto: idProyecto,
          id_grupo: idGrupoA,
          fecha: '2026-03-31',
          granularidad: 'MENSUAL',
          kwh: 5000,
        })
        .expect(201);

      const bloqueada = await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoA,
          desde: '2026-03-01',
          hasta: '2026-03-05',
          kwh: 500,
          motivo: 'Intento de relleno diario sobre un mes ya cerrado.',
        })
        .expect(409);

      expect(bloqueada.body.error.mensaje).toContain('contaria la energia dos veces');
      expect(bloqueada.body.error.detalles.conflictos[0]).toContain('2026-03');
    });

    it('la carga manual de un grupo NO se pierde aunque otro grupo tenga detalle por inversor', async () => {
      // El grupo conectado reporta por inversor el mismo dia en que el grupo
      // incomunicado solo tiene su carga consolidada.
      const inversor = await comoUsuario(operativo)
        .post('/api/inverters')
        .send({
          id_proyecto: idProyecto,
          id_grupo: idGrupoA,
          marca: 'Huawei',
          modelo: 'SUN2000-Conectado',
        })
        .expect(201);

      await comoUsuario(operativo)
        .post('/api/production')
        .send({
          id_proyecto: idProyecto,
          id_inversor: inversor.body.datos.id_inversor,
          fecha: '2026-02-10',
          kwh: 800,
        })
        .expect(201);

      await comoUsuario(operativo)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoB,
          desde: '2026-02-10',
          hasta: '2026-02-10',
          modo: 'DIARIO_UNIFORME',
          kwh: 400,
          motivo: 'El grupo incomunicado sigue sin enlace con el fabricante.',
        })
        .expect(201);

      const resumen = await comoUsuario(operativo)
        .get(`/api/production/summary?desde=2026-02-01&hasta=2026-02-28&id_proyecto=${idProyecto}`)
        .expect(200);

      // Ambos aportes se suman: 800 por inversor + 400 consolidados del grupo.
      expect(Number(resumen.body.datos.kwh)).toBe(1200);
    });

    it('el desglose por grupo separa la generacion de cada uno', async () => {
      const porGrupo = await comoUsuario(gerencial)
        .get(`/api/production/by-group?desde=2026-02-01&hasta=2026-02-28&id_proyecto=${idProyecto}`)
        .expect(200);

      const b = porGrupo.body.datos.find((g: { id_grupo: number }) => g.id_grupo === idGrupoB);
      const a = porGrupo.body.datos.find((g: { id_grupo: number }) => g.id_grupo === idGrupoA);
      expect(Number(a.kwh)).toBe(800);
      expect(Number(b.kwh)).toBe(400);
    });

    it('deja rastro auditable de cada carga manual con su motivo', async () => {
      const auditoria = await comoUsuario(admin)
        .get('/api/audit?accion=PRODUCCION_CARGA_MANUAL_GRUPO')
        .expect(200);

      expect(auditoria.body.datos.length).toBeGreaterThan(0);
      expect(auditoria.body.datos[0].motivo).toBeTruthy();
    });

    it('el gerencial no puede cargar produccion manualmente', async () => {
      await comoUsuario(gerencial)
        .post('/api/production/group-range')
        .send({
          id_grupo: idGrupoB,
          desde: '2026-01-10',
          hasta: '2026-01-11',
          kwh: 100,
          motivo: 'Intento no autorizado para la prueba de permisos.',
        })
        .expect(403);
    });

    it('los registros consolidados quedan marcados como carga manual del grupo', async () => {
      const filas = await filasProduccion(idProyecto);
      const consolidados = filas.filter((f) => f.nivel_detalle === 'GRUPO_CONSOLIDADO');
      expect(consolidados.length).toBeGreaterThan(0);
      expect(consolidados.every((f) => f.origen === 'MANUAL')).toBe(true);
      expect(consolidados[0].comentarios).toContain('Carga manual por falta de datos del fabricante');
    });
  });

  // ===========================================================================
  // Lotes de paneles: soportan generaciones de paneles distintas en un grupo
  // ===========================================================================
  describe('lotes de paneles de un grupo (distintas generaciones de potencia)', () => {
    it('registra un lote y calcula la capacidad en kWp', async () => {
      const respuesta = await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({
          cantidad: 1000,
          potencia_wp: 440,
          marca: 'Trina Solar',
          modelo: 'TSM-440',
          fecha_instalacion: '2020-01-15',
        })
        .expect(201);

      expect(respuesta.body.datos.capacidad_kwp).toBe(440);
      expect(respuesta.body.datos.mensaje).toContain('1000 panel(es) de 440 Wp');
    });

    it('suma varios lotes de distinta potencia en el total del grupo', async () => {
      // Ampliacion posterior con paneles mas potentes: mismo grupo, otra
      // generacion de paneles. El total NUNCA se recalcula a mano.
      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({ cantidad: 500, potencia_wp: 640, fecha_instalacion: '2025-06-01' })
        .expect(201);

      const detalle = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .expect(200);

      // 1000 x 440 + 500 x 640 = 440000 + 320000 = 760000 Wp = 760 kWp
      expect(Number(detalle.body.datos.cantidad_paneles)).toBe(1500);
      expect(Number(detalle.body.datos.capacidad_paneles_kwp)).toBeCloseTo(760, 4);
      expect(detalle.body.datos.paneles).toHaveLength(2);

      const listado = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups`)
        .expect(200);
      const fila = listado.body.datos.find(
        (g: { id_grupo: number }) => g.id_grupo === datos.idGrupo,
      );
      expect(Number(fila.cantidad_paneles)).toBe(1500);
      expect(Number(fila.capacidad_paneles_kwp)).toBeCloseTo(760, 4);
      expect(Number(listado.body.meta.totales.capacidadPanelesKwp)).toBeGreaterThanOrEqual(760);
    });

    it('el total del proyecto es la suma de los lotes de TODOS sus grupos, nunca un dato propio', async () => {
      const otroGrupo = await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups`)
        .send({ nombre: 'Grupo con paneles propios' })
        .expect(201);

      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${otroGrupo.body.datos.id_grupo}/panels`)
        .send({ cantidad: 100, potencia_wp: 640 })
        .expect(201);

      const detalleProyecto = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}`)
        .expect(200);

      // 760 kWp del grupo principal + 100 x 640 Wp = 64 kWp del grupo nuevo.
      expect(Number(detalleProyecto.body.datos.panelesProyecto.capacidadPanelesKwp)).toBeCloseTo(
        824,
        4,
      );
      expect(Number(detalleProyecto.body.datos.panelesProyecto.cantidadPaneles)).toBe(1600);
    });

    it('edita un lote y el total se recalcula automaticamente', async () => {
      const lotes = await comoUsuario(operativo)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .expect(200);
      const loteViejo = lotes.body.datos.find((l: { potencia_wp: string }) => Number(l.potencia_wp) === 440);

      await comoUsuario(operativo)
        .put(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels/${loteViejo.id_lote}`)
        .send({ cantidad: 900 })
        .expect(200);

      const detalle = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .expect(200);
      // 900 x 440 + 500 x 640 = 396000 + 320000 = 716000 Wp = 716 kWp
      expect(Number(detalle.body.datos.capacidad_paneles_kwp)).toBeCloseTo(716, 4);
    });

    it('retira (desactiva) un lote sin borrarlo del historico', async () => {
      const lotes = await comoUsuario(operativo)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .expect(200);
      const loteNuevo = lotes.body.datos.find((l: { potencia_wp: string }) => Number(l.potencia_wp) === 640);

      const eliminado = await comoUsuario(operativo)
        .delete(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels/${loteNuevo.id_lote}`)
        .expect(200);
      expect(eliminado.body.datos.mensaje).toContain('retirado');

      const detalle = await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}`)
        .expect(200);
      // Solo queda el lote viejo (900 x 440 = 396 kWp); el retirado no cuenta.
      expect(Number(detalle.body.datos.capacidad_paneles_kwp)).toBeCloseTo(396, 4);
      expect(detalle.body.datos.paneles).toHaveLength(1);
    });

    it('rechaza cantidad o potencia invalidas y fechas futuras', async () => {
      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({ cantidad: 0, potencia_wp: 440 })
        .expect(422);

      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({ cantidad: 10, potencia_wp: 0 })
        .expect(422);

      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({ cantidad: 10, potencia_wp: 440, fecha_instalacion: '2099-01-01' })
        .expect(422);
    });

    it('un usuario gerencial solo consulta, nunca gestiona lotes de paneles', async () => {
      await comoUsuario(gerencial)
        .get(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .expect(200);

      await comoUsuario(gerencial)
        .post(`/api/projects/${datos.idProyecto}/groups/${datos.idGrupo}/panels`)
        .send({ cantidad: 10, potencia_wp: 440 })
        .expect(403);
    });

    it('rechaza un lote sobre un grupo que no existe o de otro proyecto', async () => {
      await comoUsuario(operativo)
        .post(`/api/projects/${datos.idProyecto}/groups/999999/panels`)
        .send({ cantidad: 10, potencia_wp: 440 })
        .expect(404);
    });
  });
});
