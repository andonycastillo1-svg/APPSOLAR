import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cerrarTodo,
  comoUsuario,
  crearDatosBase,
  crearUsuario,
  iniciarSesion,
  limpiarDatos,
  PASSWORD_PRUEBAS,
  prepararBaseDeDatos,
  type DatosBase,
  type Sesion,
} from './utils/entorno';
import { execute, queryOne } from '../src/db/pool';

/** Paneles instalados por inversor: cantidad + potencia (Wp), misma potencia. */
describe('Paneles por inversor', () => {
  let admin: Sesion;
  let datos: DatosBase;

  beforeAll(async () => {
    await prepararBaseDeDatos();
    await crearUsuario('pan.admin@retse.com.gt', 'ADMINISTRATIVO');
    admin = await iniciarSesion('pan.admin@retse.com.gt', PASSWORD_PRUEBAS);
  }, 120000);

  beforeEach(async () => {
    await limpiarDatos();
    datos = await crearDatosBase();
  });

  afterAll(async () => {
    await cerrarTodo();
  });

  const nuevoInversor = (extra: Record<string, unknown>) =>
    comoUsuario(admin)
      .post('/api/inverters')
      .send({
        id_proyecto: datos.idProyecto,
        id_grupo: datos.idGrupo,
        marca: 'Huawei',
        modelo: 'SUN2000-50KTL',
        tipo_conexion: 'MANUAL',
        ...extra,
      });

  it('guarda la cantidad de paneles y la potencia de cada uno', async () => {
    const r = await nuevoInversor({ serial_externo: 'PAN-1', cantidad_paneles: 100, potencia_panel_wp: 550 });
    expect(r.status).toBe(201);

    const detalle = await comoUsuario(admin).get(`/api/inverters/${r.body.datos.id_inversor}`).expect(200);
    expect(detalle.body.datos.cantidad_paneles).toBe(100);
    expect(Number(detalle.body.datos.potencia_panel_wp)).toBe(550);
  });

  it('exige ambos datos o ninguno y rechaza valores invalidos', async () => {
    expect((await nuevoInversor({ cantidad_paneles: 100 })).status).toBe(422);
    expect((await nuevoInversor({ potencia_panel_wp: 550 })).status).toBe(422);
    expect((await nuevoInversor({ cantidad_paneles: 0, potencia_panel_wp: 550 })).status).toBe(422);
    expect((await nuevoInversor({ cantidad_paneles: 10, potencia_panel_wp: -5 })).status).toBe(422);
    expect((await nuevoInversor({ cantidad_paneles: 10.5, potencia_panel_wp: 550 })).status).toBe(422);
    // Sin paneles sigue siendo valido.
    expect((await nuevoInversor({ serial_externo: 'SIN-PAN' })).status).toBe(201);
  });

  it('al editar valida contra lo ya guardado', async () => {
    const r = await nuevoInversor({ serial_externo: 'PAN-2', cantidad_paneles: 20, potencia_panel_wp: 450 });
    const id = r.body.datos.id_inversor;
    await comoUsuario(admin).put(`/api/inverters/${id}`).send({ cantidad_paneles: 30 }).expect(200);
    await comoUsuario(admin)
      .put(`/api/inverters/${id}`)
      .send({ cantidad_paneles: null })
      .expect(422);
  });

  it('el grupo y el proyecto suman los inversores y no cuentan dos veces los lotes', async () => {
    // Un lote del grupo (1000 paneles de 400 Wp) que NO debe sumarse
    // cuando los inversores ya traen su detalle.
    await execute(
      'INSERT INTO paneles_grupo (id_grupo, cantidad, potencia_wp, activo) VALUES (?, 1000, 400, 1)',
      [datos.idGrupo],
    );
    const antes = await comoUsuario(admin).get(`/api/projects/${datos.idProyecto}`).expect(200);
    expect(Number(antes.body.datos.grupos[0].cantidad_paneles)).toBe(1000);
    expect(antes.body.datos.grupos[0].origen_paneles).toBe('LOTES');

    await nuevoInversor({ serial_externo: 'A', cantidad_paneles: 100, potencia_panel_wp: 550 }).expect(201);
    await nuevoInversor({ serial_externo: 'B', cantidad_paneles: 50, potencia_panel_wp: 640 }).expect(201);

    const despues = await comoUsuario(admin).get(`/api/projects/${datos.idProyecto}`).expect(200);
    const grupo = despues.body.datos.grupos[0];
    expect(Number(grupo.cantidad_paneles)).toBe(150);
    expect(Number(grupo.capacidad_paneles_kwp)).toBeCloseTo(87, 3); // 55 + 32
    expect(grupo.origen_paneles).toBe('INVERSORES');
    expect(despues.body.datos.panelesProyecto.cantidadPaneles).toBe(150);

    const fila = await queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM paneles_grupo WHERE id_grupo = ? AND activo = 1',
      [datos.idGrupo],
    );
    expect(Number(fila?.n)).toBe(1); // el lote sigue ahi, solo no se suma
  });
});
