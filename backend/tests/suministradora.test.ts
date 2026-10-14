import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
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
import { execute, query, queryOne } from '../src/db/pool';
import { trimestreActual } from '../src/utils/fechas';

/**
 * Suministradora del proyecto: DISTRIBUIDORA (tarifa que se renueva cada
 * trimestre) o COMERCIALIZADORA (valor pactado fijo).
 */
describe('Suministradora, tipos de tarifa y valor pactado', () => {
  let admin: Sesion;
  let operativo: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('sum.admin@retse.com.gt', 'ADMINISTRATIVO');
    await crearUsuario('sum.oper@retse.com.gt', 'OPERATIVO');
    admin = await iniciarSesion('sum.admin@retse.com.gt', PASSWORD_PRUEBAS);
    operativo = await iniciarSesion('sum.oper@retse.com.gt', PASSWORD_PRUEBAS);
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
  });

  afterAll(async () => {
    await cerrarTodo();
  });

  const alta = (extra: Record<string, unknown>, nombre = 'Planta Suministro') =>
    comoUsuario(admin)
      .post('/api/projects')
      .send(cuerpoAltaProyecto(datos.idCliente, nombre, extra));

  it('expone el catalogo de tipos de tarifa con sus siglas', async () => {
    const r = await comoUsuario(operativo).get('/api/projects/rate-types').expect(200);
    const siglas = (r.body.datos as Array<{ sigla: string }>).map((t) => t.sigla);
    expect(siglas).toHaveLength(12);
    expect(siglas).toEqual(expect.arrayContaining(['TS', 'BTSA', 'AP', 'BTDA', 'MTHD', 'PMT']));
  });

  describe('validaciones del alta', () => {
    it('exige suministradora y tipo de tarifa', async () => {
      const sinSuministradora = await alta({ suministradora: null });
      expect(sinSuministradora.status).toBe(422);
      expect(JSON.stringify(sinSuministradora.body.error)).toMatch(/suministradora/i);

      const sinTipo = await alta({ id_tipo_tarifa: null });
      expect(sinTipo.status).toBe(422);
      expect(JSON.stringify(sinTipo.body.error)).toMatch(/tipo de tarifa/i);
    });

    it('PPA es siempre distribuidora y EPC siempre comercializadora', async () => {
      const ppa = await alta({ tipo_proyecto: 'PPA', suministradora: 'COMERCIALIZADORA', valor_pactado_kwh: 1 });
      expect(ppa.status).toBe(422);
      expect(JSON.stringify(ppa.body.error)).toMatch(/PPA.*distribuidora/i);

      const epc = await alta({ tipo_proyecto: 'EPC', suministradora: 'DISTRIBUIDORA' });
      expect(epc.status).toBe(422);
      expect(JSON.stringify(epc.body.error)).toMatch(/EPC.*comercializadora/i);
    });

    it('la comercializadora requiere valor pactado y la distribuidora no lo admite', async () => {
      const sinValor = await alta({ tipo_proyecto: 'EPC', suministradora: 'COMERCIALIZADORA' });
      expect(sinValor.status).toBe(422);
      expect(JSON.stringify(sinValor.body.error)).toMatch(/valor pactado/i);

      const conValor = await alta({ tipo_proyecto: 'PPA', suministradora: 'DISTRIBUIDORA', valor_pactado_kwh: 1.1 });
      expect(conValor.status).toBe(422);
    });

    it('rechaza un tipo de tarifa inexistente', async () => {
      const r = await alta({ id_tipo_tarifa: 9999 });
      expect(r.status).toBe(422);
    });
  });

  describe('distribuidora: la tarifa se renueva cada trimestre', () => {
    it('captura la tarifa del trimestre en curso durante el alta', async () => {
      const r = await alta({ tarifa_vigente_kwh: 1.37 }).then((x) => {
        expect(x.status).toBe(201);
        return x;
      });
      const { anio, trimestre } = trimestreActual();
      const tarifa = await queryOne<{ costo_kwh: number; estado: string; origen: string }>(
        'SELECT costo_kwh, estado, origen FROM tarifas_kwh WHERE id_proyecto = ? AND anio = ? AND trimestre = ?',
        [r.body.datos.id_proyecto, anio, trimestre],
      );
      expect(Number(tarifa?.costo_kwh)).toBe(1.37);
      expect(tarifa?.estado).toBe('APROBADA');
      expect(tarifa?.origen).toBe('MANUAL');

      const ficha = await comoUsuario(admin).get(`/api/projects/${r.body.datos.id_proyecto}`).expect(200);
      expect(ficha.body.datos.suministradora).toBe('DISTRIBUIDORA');
      expect(ficha.body.datos.tipo_tarifa_sigla).toBe('TS');
    });
  });

  describe('comercializadora: valor pactado fijo', () => {
    const comoComercializadora = async () => {
      await execute(
        `UPDATE proyectos SET tipo_proyecto = 'EPC', suministradora = 'COMERCIALIZADORA',
                valor_pactado_kwh = 0.9 WHERE id_proyecto = ?`,
        [datos.idProyecto],
      );
    };

    it('valoriza cualquier trimestre con el valor pactado, sin renovacion', async () => {
      await comoComercializadora();
      for (const fecha of ['2025-12-10', '2026-04-10', '2026-08-10']) {
        await comoUsuario(admin)
          .post('/api/production')
          .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha, kwh: 100 })
          .expect(201);
      }
      const filas = await filasProduccion(datos.idProyecto);
      expect(filas).toHaveLength(3);
      expect(filas.every((f) => Number(f.costo_kwh_aplicado) === 0.9)).toBe(true);
      expect(filas.every((f) => Number(f.valor_q) === 90)).toBe(true);
      expect(filas.every((f) => f.estado_valorizacion === 'VALORIZADA')).toBe(true);
    });

    it('no genera alertas de renovacion trimestral', async () => {
      await comoComercializadora();
      const r = await comoUsuario(admin).get(`/api/projects/${datos.idProyecto}/rates/alert`).expect(200);
      expect(r.body.datos.proyectosSinTarifaActual).toHaveLength(0);
      expect(r.body.datos.proyectosSinTarifaSiguiente).toHaveLength(0);
    });

    it('muestra el valor pactado en los cuatro trimestres y no deja capturar tarifas', async () => {
      await comoComercializadora();
      const r = await comoUsuario(admin).get(`/api/projects/${datos.idProyecto}/rates?anio=2025`).expect(200);
      expect(r.body.datos.resumen.trimestresAprobados).toBe(4);
      for (const t of r.body.datos.calendario) expect(Number(t.tarifa.costo_kwh)).toBe(0.9);

      await comoUsuario(admin)
        .post(`/api/projects/${datos.idProyecto}/rates`)
        .send({ anio: 2025, trimestre: 1, costo_kwh: 5 })
        .expect(409);

      const idPactada = r.body.datos.calendario[0].tarifa.id_tarifa;
      await comoUsuario(admin)
        .post(`/api/projects/${datos.idProyecto}/rates/${idPactada}/annul`)
        .send({ motivo: 'Intento de anular el valor pactado del proyecto.' })
        .expect(409);
    });

    it('cambiar el valor pactado exige motivo y recalcula la produccion', async () => {
      await comoComercializadora();
      await comoUsuario(admin)
        .post('/api/production')
        .send({ id_proyecto: datos.idProyecto, id_inversor: datos.idInversor, fecha: '2026-04-10', kwh: 100 })
        .expect(201);

      const sinMotivo = await comoUsuario(admin)
        .put(`/api/projects/${datos.idProyecto}`)
        .send({ valor_pactado_kwh: 1.2 });
      expect(sinMotivo.status).toBe(422);

      await comoUsuario(admin)
        .put(`/api/projects/${datos.idProyecto}`)
        .send({ valor_pactado_kwh: 1.2, motivo_tarifa: 'Adenda contractual firmada con el cliente.' })
        .expect(200);

      const filas = await filasProduccion(datos.idProyecto);
      expect(Number(filas[0].costo_kwh_aplicado)).toBe(1.2);
      expect(Number(filas[0].valor_q)).toBe(120);

      const pendientes = await query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tarifas_kwh WHERE id_proyecto = ? AND origen = 'PACTADA' AND costo_kwh <> 1.2",
        [datos.idProyecto],
      );
      expect(Number(pendientes[0].n)).toBe(0);
    });

    it('no admite cambiar la modalidad a una combinacion incoherente', async () => {
      await comoComercializadora();
      const r = await comoUsuario(admin)
        .put(`/api/projects/${datos.idProyecto}`)
        .send({ tipo_proyecto: 'PPA' });
      expect(r.status).toBe(422);
    });
  });
});
