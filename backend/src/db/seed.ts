import { env } from '../config/env';
import { logger } from '../config/logger';
import { execute, query, queryOne } from './pool';
import { hashPassword, validarFortalezaPassword } from '../services/auth';
import { calcularValorQ, redondearKwh } from '../utils/numeros';
import { diasEnMes } from '../utils/fechas';

/**
 * Datos iniciales.
 *
 * `bootstrapAdministrador` crea el unico usuario administrativo inicial a
 * partir de variables de entorno: el repositorio NUNCA contiene credenciales.
 * `sembrarDemostracion` agrega informacion FICTICIA, claramente identificada,
 * y solo se ejecuta cuando SEED_DEMO_DATA esta habilitado.
 */

async function idRol(codigo: string): Promise<number> {
  const fila = await queryOne<{ id_rol: number }>('SELECT id_rol FROM roles WHERE codigo = ?', [codigo]);
  if (!fila) throw new Error(`El rol ${codigo} no existe. Ejecute primero las migraciones.`);
  return fila.id_rol;
}

export async function bootstrapAdministrador(): Promise<void> {
  const password = env.bootstrap.adminPassword;
  if (!password) {
    throw new Error(
      'Defina BOOTSTRAP_ADMIN_PASSWORD en el entorno para crear el administrador inicial. ' +
        'No existe ninguna contrasena por defecto.',
    );
  }

  const problemas = validarFortalezaPassword(password);
  if (problemas.length > 0) {
    throw new Error(
      `La contrasena de BOOTSTRAP_ADMIN_PASSWORD no cumple la politica de seguridad: ${problemas.join(' ')}`,
    );
  }

  const existente = await queryOne<{ id_usuario: number }>(
    'SELECT id_usuario FROM usuarios WHERE email = ?',
    [env.bootstrap.adminEmail],
  );

  if (existente) {
    logger.info(`El administrador inicial (${env.bootstrap.adminEmail}) ya existe: no se modifico.`);
    return;
  }

  await execute(
    `INSERT INTO usuarios (nombre, email, password_hash, id_rol, activo, debe_cambiar_password)
     VALUES (?, ?, ?, ?, 1, 0)`,
    [
      env.bootstrap.adminName,
      env.bootstrap.adminEmail,
      await hashPassword(password),
      await idRol('ADMINISTRATIVO'),
    ],
  );

  logger.info(`Administrador inicial creado: ${env.bootstrap.adminEmail}`);
}

// ---------------------------------------------------------------------------
// Datos de demostracion
// ---------------------------------------------------------------------------

interface DemoContexto {
  admin: number;
  operativo: number;
  coordinador: number;
  gerencial: number;
}

/** Perfil de estacionalidad solar de Guatemala (factor por mes). */
const ESTACIONALIDAD = [1.02, 1.06, 1.12, 1.05, 0.92, 0.82, 0.88, 0.9, 0.85, 0.9, 0.98, 1.0];

/** Generador pseudoaleatorio determinista para que la demo sea reproducible. */
function aleatorio(semilla: number): () => number {
  let estado = semilla;
  return () => {
    estado = (estado * 1664525 + 1013904223) % 4294967296;
    return estado / 4294967296;
  };
}

async function crearUsuariosDemo(): Promise<DemoContexto> {
  const password = env.bootstrap.demoPassword;
  if (!password) {
    throw new Error(
      'Defina DEMO_USER_PASSWORD para crear los usuarios de demostracion, o desactive SEED_DEMO_DATA.',
    );
  }
  const problemas = validarFortalezaPassword(password);
  if (problemas.length > 0) {
    throw new Error(`DEMO_USER_PASSWORD no cumple la politica de seguridad: ${problemas.join(' ')}`);
  }

  const hash = await hashPassword(password);
  const definiciones = [
    { nombre: 'Demo Administrador', email: 'demo.admin@retse.com.gt', rol: 'ADMINISTRATIVO' },
    { nombre: 'Demo Operativo', email: 'demo.operativo@retse.com.gt', rol: 'OPERATIVO' },
    { nombre: 'Demo Coordinador de Tarifas', email: 'demo.coordinador@retse.com.gt', rol: 'OPERATIVO' },
    { nombre: 'Demo Gerencia', email: 'demo.gerencia@retse.com.gt', rol: 'GERENCIAL' },
  ];

  const ids: Record<string, number> = {};
  for (const definicion of definiciones) {
    const existente = await queryOne<{ id_usuario: number }>(
      'SELECT id_usuario FROM usuarios WHERE email = ?',
      [definicion.email],
    );
    if (existente) {
      ids[definicion.email] = existente.id_usuario;
      continue;
    }
    const resultado = await execute(
      `INSERT INTO usuarios (nombre, email, password_hash, id_rol, activo, debe_cambiar_password, es_demo)
       VALUES (?, ?, ?, ?, 1, 0, 1)`,
      [definicion.nombre, definicion.email, hash, await idRol(definicion.rol)],
    );
    ids[definicion.email] = resultado.insertId;
  }

  // El coordinador es un usuario OPERATIVO con el permiso individual
  // `tarifas.gestionar` (no se creo un cuarto rol global).
  const permiso = await queryOne<{ id_permiso: number }>(
    "SELECT id_permiso FROM permisos WHERE codigo = 'tarifas.gestionar'",
  );
  if (permiso) {
    await execute(
      `INSERT IGNORE INTO usuario_permisos (id_usuario, id_permiso, otorgado)
       VALUES (?, ?, 1)`,
      [ids['demo.coordinador@retse.com.gt'], permiso.id_permiso],
    );
  }

  return {
    admin: ids['demo.admin@retse.com.gt'],
    operativo: ids['demo.operativo@retse.com.gt'],
    coordinador: ids['demo.coordinador@retse.com.gt'],
    gerencial: ids['demo.gerencia@retse.com.gt'],
  };
}

export async function sembrarDemostracion(): Promise<void> {
  const yaSembrado = await queryOne<{ total: number }>(
    "SELECT COUNT(*) AS total FROM clientes WHERE nombre LIKE 'DEMO%'",
  );
  if ((yaSembrado?.total ?? 0) > 0) {
    logger.info('Los datos de demostracion ya existen: no se duplicaron.');
    return;
  }

  const usuarios = await crearUsuariosDemo();
  const anioActual = new Date().getFullYear();
  const anioAnterior = anioActual - 1;
  const mesActual = new Date().getMonth() + 1;

  // --- Clientes ---------------------------------------------------------
  const clienteA = (
    await execute(
      `INSERT INTO clientes (nombre, nit, ubicacion, contacto, telefono, email, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        'DEMO Agroindustrias del Pacifico, S.A.',
        '12345678-9',
        'Escuintla, Guatemala',
        'Ana Lucia Morales',
        '+502 5555-1010',
        'contacto@demo-agroindustrias.gt',
        usuarios.admin,
      ],
    )
  ).insertId;

  const clienteB = (
    await execute(
      `INSERT INTO clientes (nombre, nit, ubicacion, contacto, telefono, email, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        'DEMO Textiles del Altiplano, S.A.',
        '87654321-0',
        'Quetzaltenango, Guatemala',
        'Jorge Estuardo Ramirez',
        '+502 5555-2020',
        'contacto@demo-textiles.gt',
        usuarios.admin,
      ],
    )
  ).insertId;

  // --- Proyectos --------------------------------------------------------
  const proyectos = [
    {
      cliente: clienteA,
      nombre: 'DEMO Planta Solar Escuintla I',
      ubicacion: 'Escuintla, Guatemala',
      tipo: 'PPA',
      kwp: 1250.0,
      inicio: `${anioAnterior}-01-01`,
      baseMensual: 168000,
      detalle: 'POR_INVERSOR' as const,
    },
    {
      cliente: clienteA,
      nombre: 'DEMO Planta Solar Retalhuleu',
      ubicacion: 'Retalhuleu, Guatemala',
      tipo: 'EPC',
      kwp: 800.0,
      inicio: `${anioAnterior}-01-01`,
      baseMensual: 108000,
      // Se carga como consolidado mensual, igual que el Excel historico.
      detalle: 'PROYECTO_CONSOLIDADO' as const,
    },
    {
      cliente: clienteB,
      nombre: 'DEMO Autoconsumo Textiles Xela',
      ubicacion: 'Quetzaltenango, Guatemala',
      tipo: 'AUTOCONSUMO',
      kwp: 450.0,
      inicio: `${anioAnterior}-04-01`,
      baseMensual: 58000,
      detalle: 'POR_INVERSOR' as const,
    },
  ];

  const idsProyecto: number[] = [];
  for (const proyecto of proyectos) {
    const resultado = await execute(
      `INSERT INTO proyectos
         (id_cliente, nombre, ubicacion, tipo_proyecto, capacidad_kwp, fecha_inicio,
          observaciones, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        proyecto.cliente,
        proyecto.nombre,
        proyecto.ubicacion,
        proyecto.tipo,
        proyecto.kwp,
        proyecto.inicio,
        'Proyecto de demostracion con datos ficticios.',
        usuarios.admin,
      ],
    );
    idsProyecto.push(resultado.insertId);
  }

  // --- Configuracion de la integracion Huawei (modo simulado) -----------
  const idApi = (
    await execute(
      `INSERT INTO apis_fabricante
         (marca, nombre, endpoint, ip_autorizada, usuario_api, secreto_ref, modo, estado,
          timeout_s, max_reintentos, sync_programada, sync_hora)
       VALUES ('HUAWEI', 'Huawei SmartPVMS', ?, ?, ?, ?, 'MOCK', 'ACTIVA', 40, 3, 0, '02:30')`,
      [
        env.huawei.baseUrl,
        env.huawei.authorizedIp || null,
        'usuario_api_demo',
        'env:HUAWEI_SYSTEM_CODE',
      ],
    )
  ).insertId;

  // --- Inversores -------------------------------------------------------
  const inversores: Array<{ id: number; proyecto: number; participacion: number; huawei: boolean }> = [];

  const definicionInversores = [
    { proyecto: 0, marca: 'Huawei', modelo: 'SUN2000-100KTL-M1', conexion: 'HUAWEI_API', serial: 'HW-ESC-001', kwp: 500, participacion: 0.4 },
    { proyecto: 0, marca: 'Huawei', modelo: 'SUN2000-100KTL-M1', conexion: 'HUAWEI_API', serial: 'HW-ESC-002', kwp: 500, participacion: 0.4 },
    { proyecto: 0, marca: 'Fronius', modelo: 'Symo 24.0-3', conexion: 'MANUAL', serial: 'FR-ESC-003', kwp: 250, participacion: 0.2 },
    { proyecto: 2, marca: 'SMA', modelo: 'Sunny Tripower 25000TL', conexion: 'MANUAL', serial: 'SMA-XELA-001', kwp: 250, participacion: 0.55 },
    { proyecto: 2, marca: 'SMA', modelo: 'Sunny Tripower 20000TL', conexion: 'MANUAL', serial: 'SMA-XELA-002', kwp: 200, participacion: 0.45 },
  ];

  for (const definicion of definicionInversores) {
    const resultado = await execute(
      `INSERT INTO inversores
         (id_proyecto, marca, modelo, tipo_conexion, serial_externo, estacion_externa,
          capacidad_kwp, estado, id_api, observaciones, activo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?, ?, 1, ?)`,
      [
        idsProyecto[definicion.proyecto],
        definicion.marca,
        definicion.modelo,
        definicion.conexion,
        definicion.serial,
        definicion.conexion === 'HUAWEI_API' ? 'NE=DEMO-STATION-01' : null,
        definicion.kwp,
        definicion.conexion === 'HUAWEI_API' ? idApi : null,
        'Inversor de demostracion.',
        usuarios.admin,
      ],
    );
    inversores.push({
      id: resultado.insertId,
      proyecto: definicion.proyecto,
      participacion: definicion.participacion,
      huawei: definicion.conexion === 'HUAWEI_API',
    });
  }

  // --- Tarifas mensuales ------------------------------------------------
  // Las tarifas CAMBIAN entre meses y un mes queda deliberadamente PENDIENTE
  // para demostrar la alerta de valorizacion.
  const mesPendiente = Math.max(1, mesActual - 1);
  const tarifasPorProyecto = [1.12, 0.98, 1.35];

  for (let indice = 0; indice < idsProyecto.length; indice += 1) {
    const base = tarifasPorProyecto[indice];
    for (const anio of [anioAnterior, anioActual]) {
      const mesesDelAnio = anio === anioActual ? mesActual : 12;
      for (let mes = 1; mes <= mesesDelAnio; mes += 1) {
        // Mes deliberadamente sin tarifa en el primer proyecto.
        if (indice === 0 && anio === anioActual && mes === mesPendiente) continue;

        const costo = Number((base + (mes % 4) * 0.035 + (anio - anioAnterior) * 0.06).toFixed(6));
        await execute(
          `INSERT INTO tarifas_kwh
             (id_proyecto, anio, mes, costo_kwh, moneda, estado, origen, creado_por,
              aprobado_por, fecha_aprobacion)
           VALUES (?, ?, ?, ?, 'GTQ', 'APROBADA', 'MANUAL', ?, ?, NOW())`,
          [idsProyecto[indice], anio, mes, costo, usuarios.coordinador, usuarios.admin],
        );
      }
    }
  }

  // --- Proyecciones mensuales (12 meses para dos proyectos) -------------
  for (const indice of [0, 1]) {
    for (const anio of [anioAnterior, anioActual]) {
      for (let mes = 1; mes <= 12; mes += 1) {
        const proyeccion = redondearKwh(proyectos[indice].baseMensual * ESTACIONALIDAD[mes - 1] * 0.97);
        await execute(
          `INSERT INTO proyecciones_kwh
             (id_proyecto, anio, mes, proyeccion_kwh, estado, origen, creado_por,
              aprobado_por, fecha_aprobacion, comentarios)
           VALUES (?, ?, ?, ?, 'APROBADA', 'MANUAL', ?, ?, NOW(), ?)`,
          [
            idsProyecto[indice],
            anio,
            mes,
            proyeccion,
            usuarios.operativo,
            usuarios.admin,
            'Proyeccion de demostracion.',
          ],
        );
      }
    }
  }

  // --- Produccion -------------------------------------------------------
  const rnd = aleatorio(20260821);

  const tarifaDe = async (idProyecto: number, anio: number, mes: number) =>
    queryOne<{ id_tarifa: number; costo_kwh: number }>(
      `SELECT id_tarifa, costo_kwh FROM tarifas_kwh
        WHERE id_proyecto = ? AND anio = ? AND mes = ? AND estado = 'APROBADA'`,
      [idProyecto, anio, mes],
    );

  const insertarProduccion = async (parametros: {
    idProyecto: number;
    idInversor: number | null;
    fecha: string;
    anio: number;
    mes: number;
    granularidad: 'DIARIA' | 'MENSUAL';
    kwh: number;
    origen: 'MANUAL' | 'HUAWEI_API';
    secuencia?: number;
    comentarios?: string | null;
    idSync?: number | null;
  }) => {
    const tarifa = await tarifaDe(parametros.idProyecto, parametros.anio, parametros.mes);
    await execute(
      `INSERT INTO produccion
         (id_proyecto, id_inversor, nivel_detalle, fecha, anio, mes, granularidad, kwh,
          origen, secuencia, id_sync, id_tarifa, costo_kwh_aplicado, valor_q,
          estado_valorizacion, comentarios, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parametros.idProyecto,
        parametros.idInversor,
        parametros.idInversor ? 'POR_INVERSOR' : 'PROYECTO_CONSOLIDADO',
        parametros.fecha,
        parametros.anio,
        parametros.mes,
        parametros.granularidad,
        parametros.kwh,
        parametros.origen,
        parametros.secuencia ?? 0,
        parametros.idSync ?? null,
        tarifa?.id_tarifa ?? null,
        tarifa?.costo_kwh ?? null,
        tarifa ? calcularValorQ(parametros.kwh, tarifa.costo_kwh) : null,
        tarifa ? 'VALORIZADA' : 'PENDIENTE_DE_TARIFA',
        parametros.comentarios ?? null,
        usuarios.operativo,
      ],
    );
  };

  // Proyecto 1 y 3: detalle POR INVERSOR, granularidad MENSUAL.
  for (const inversor of inversores) {
    const indiceProyecto = inversor.proyecto;
    const idProyecto = idsProyecto[indiceProyecto];
    const base = proyectos[indiceProyecto].baseMensual * inversor.participacion;

    for (const anio of [anioAnterior, anioActual]) {
      const mesesDelAnio = anio === anioActual ? mesActual : 12;
      for (let mes = 1; mes <= mesesDelAnio; mes += 1) {
        if (indiceProyecto === 2 && anio === anioAnterior && mes < 4) continue; // entro en operacion en abril
        const variacion = 0.93 + rnd() * 0.14;
        const kwh = redondearKwh(base * ESTACIONALIDAD[mes - 1] * variacion);
        await insertarProduccion({
          idProyecto,
          idInversor: inversor.id,
          fecha: `${anio}-${String(mes).padStart(2, '0')}-01`,
          anio,
          mes,
          granularidad: 'MENSUAL',
          kwh,
          origen: inversor.huawei ? 'HUAWEI_API' : 'MANUAL',
        });
      }
    }
  }

  // Proyecto 2: consolidado mensual, tal como llega del Excel historico.
  for (const anio of [anioAnterior, anioActual]) {
    const mesesDelAnio = anio === anioActual ? mesActual : 12;
    for (let mes = 1; mes <= mesesDelAnio; mes += 1) {
      const kwh = redondearKwh(proyectos[1].baseMensual * ESTACIONALIDAD[mes - 1] * (0.9 + rnd() * 0.18));
      await insertarProduccion({
        idProyecto: idsProyecto[1],
        idInversor: null,
        fecha: `${anio}-${String(mes).padStart(2, '0')}-01`,
        anio,
        mes,
        granularidad: 'MENSUAL',
        kwh,
        origen: 'MANUAL',
        comentarios: mes === 6 ? 'Mantenimiento preventivo programado' : null,
      });
    }
  }

  // --- Sincronizaciones Huawei simuladas --------------------------------
  const sync1 = (
    await execute(
      `INSERT INTO sincronizaciones
         (id_api, id_proyecto, tipo, modo, estado, rango_desde, rango_hasta, granularidad,
          filas_recibidas, insertadas, actualizadas, rechazadas, duracion_ms, mensaje, id_usuario, finalizada_en)
       VALUES (?, ?, 'MANUAL', 'MOCK', 'COMPLETADA', ?, ?, 'DIARIA', 60, 60, 0, 0, 1840,
               'Sincronizacion simulada finalizada correctamente.', ?, NOW())`,
      [
        idApi,
        idsProyecto[0],
        `${anioActual}-${String(mesActual).padStart(2, '0')}-01`,
        `${anioActual}-${String(mesActual).padStart(2, '0')}-${String(Math.min(28, diasEnMes(anioActual, mesActual))).padStart(2, '0')}`,
        usuarios.operativo,
      ],
    )
  ).insertId;

  await execute(
    `INSERT INTO sincronizaciones
       (id_api, id_proyecto, tipo, modo, estado, rango_desde, rango_hasta, granularidad,
        filas_recibidas, insertadas, actualizadas, rechazadas, duracion_ms, codigo_error,
        mensaje, id_usuario, finalizada_en)
     VALUES (?, ?, 'MANUAL', 'REAL', 'FALLIDA', ?, ?, 'DIARIA', 0, 0, 0, 0, 320, 'IP_NO_AUTORIZADA',
             'La IP publica del servidor no esta autorizada por Huawei.', ?, NOW())`,
    [
      idApi,
      idsProyecto[0],
      `${anioAnterior}-12-01`,
      `${anioAnterior}-12-31`,
      usuarios.operativo,
    ],
  );

  await execute('UPDATE apis_fabricante SET ultima_sincronizacion = NOW() WHERE id_api = ?', [idApi]);
  void sync1;

  // --- Historiales de importacion ---------------------------------------
  const historicoOk = (
    await execute(
      `INSERT INTO historicos
         (id_proyecto, formato, nivel_detalle, nombre_archivo_original, nombre_archivo_seguro,
          hash_sha256, tamano_bytes, id_usuario, estado, total_filas, insertadas, actualizadas,
          duplicadas, rechazadas, fecha_min, fecha_max, mensaje, confirmado_en)
       VALUES (?, 'HISTORICO_EXCEL', 'PROYECTO_CONSOLIDADO', 'historico_generacion_2025.xlsx',
               '1700000000000_demoimporta01.xlsx', ?, 24576, ?, 'COMPLETADO', 12, 12, 0, 0, 0,
               ?, ?, 'Importacion de demostracion finalizada correctamente.', NOW())`,
      [
        idsProyecto[1],
        'a'.repeat(64),
        usuarios.operativo,
        `${anioAnterior}-01-01`,
        `${anioAnterior}-12-01`,
      ],
    )
  ).insertId;

  const historicoError = (
    await execute(
      `INSERT INTO historicos
         (id_proyecto, formato, nivel_detalle, nombre_archivo_original, nombre_archivo_seguro,
          hash_sha256, tamano_bytes, id_usuario, estado, total_filas, insertadas, actualizadas,
          duplicadas, rechazadas, advertencias, mensaje, confirmado_en)
       VALUES (?, 'HISTORICO_EXCEL', 'PROYECTO_CONSOLIDADO', 'historico_con_errores.csv',
               '1700000000001_demoimporta02.csv', ?, 1024, ?, 'COMPLETADO_CON_ERRORES', 10, 2, 0, 0, 6, 2,
               'Importacion de demostracion con filas rechazadas.', NOW())`,
      [idsProyecto[1], 'b'.repeat(64), usuarios.operativo],
    )
  ).insertId;

  const erroresDemo = [
    [2, 'Anio', '1899', 'ANIO_INVALIDO', 'ERROR', 'El anio debe ser un entero valido entre 2000 y 2100.'],
    [3, 'Mes', 'Trecemberre', 'MES_INVALIDO', 'ERROR', 'El mes no se reconocio.'],
    [4, 'Generacion', 'abc', 'KWH_NO_NUMERICO', 'ERROR', 'La generacion debe ser un valor numerico en kWh.'],
    [5, 'Generacion', '-500', 'KWH_NEGATIVO', 'ERROR', 'No se aceptan valores de energia negativos.'],
    [6, 'Planta', '', 'PLANTA_VACIA', 'ERROR', 'La columna Planta es obligatoria.'],
    [7, 'Planta', 'Planta Inexistente XYZ', 'PLANTA_NO_ENCONTRADA', 'ERROR', 'La planta no coincide con ningun proyecto registrado.'],
    [10, null, null, 'GRUPO_MULTIPLE', 'ADVERTENCIA', 'Dos filas de la misma planta y mes sin identificador de inversor: requiere decision.'],
    [8, 'Generacion', '=1+1', 'FORMULA_DETECTADA', 'ADVERTENCIA', 'Se detecto una formula y se neutralizo su contenido.'],
  ];
  for (const error of erroresDemo) {
    await execute(
      `INSERT INTO historico_errores (id_historico, fila, columna, valor, codigo, severidad, mensaje)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [historicoError, ...error],
    );
  }
  void historicoOk;

  // --- Cierre mensual de demostracion ------------------------------------
  await execute(
    `INSERT INTO cierres_mensuales (id_proyecto, anio, mes, estado, cerrado_por, fecha_cierre, motivo)
     VALUES (?, ?, 1, 'CERRADO', ?, NOW(), 'Cierre contable de demostracion.')`,
    [idsProyecto[0], anioAnterior, usuarios.admin],
  );

  // --- Actualizacion de la ultima fecha por inversor ----------------------
  await execute(
    `UPDATE inversores i
        SET i.ultima_actualizacion = (
              SELECT MAX(p.fecha) FROM produccion p
               WHERE p.id_inversor = i.id_inversor AND p.activo = 1)`,
  );

  const totales = await query<{ tabla: string; total: number }>(
    `SELECT 'clientes' AS tabla, COUNT(*) AS total FROM clientes
     UNION ALL SELECT 'proyectos', COUNT(*) FROM proyectos
     UNION ALL SELECT 'inversores', COUNT(*) FROM inversores
     UNION ALL SELECT 'tarifas', COUNT(*) FROM tarifas_kwh
     UNION ALL SELECT 'proyecciones', COUNT(*) FROM proyecciones_kwh
     UNION ALL SELECT 'produccion', COUNT(*) FROM produccion
     UNION ALL SELECT 'usuarios', COUNT(*) FROM usuarios`,
  );

  logger.info(
    { totales },
    'Datos de demostracion creados. Todos los registros llevan el prefijo DEMO y son ficticios.',
  );
  logger.info(
    `Mes deliberadamente SIN tarifa para demostrar la alerta: ${String(mesPendiente).padStart(2, '0')}/${anioActual} en "${proyectos[0].nombre}".`,
  );
}
