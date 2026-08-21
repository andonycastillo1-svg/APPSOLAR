import fs from 'node:fs';
import path from 'node:path';
import {
  plantillaConErroresCsv,
  plantillaHistoricaCsv,
  plantillaNormalizadaCsv,
  plantillaXlsx,
} from '../services/etl';
import { env } from '../config/env';

/**
 * Genera las plantillas y el archivo de ejemplo con errores en
 * `database/seeds/`, usando exactamente el mismo codigo que sirve el API.
 *
 *   npm run --workspace backend db:plantillas
 */
async function generar(): Promise<void> {
  const destino = env.paths.templates;
  fs.mkdirSync(destino, { recursive: true });

  const BOM = '﻿';
  const escribir = (nombre: string, contenido: string | Buffer) => {
    fs.writeFileSync(path.join(destino, nombre), contenido);
    console.log(`Generado: database/seeds/${nombre}`);
  };

  escribir('plantilla_historica.csv', BOM + plantillaHistoricaCsv());
  escribir('plantilla_normalizada.csv', BOM + plantillaNormalizadaCsv());
  escribir('ejemplo_con_errores.csv', BOM + plantillaConErroresCsv());
  escribir('plantilla_historica.xlsx', await plantillaXlsx('HISTORICO_EXCEL'));
  escribir('plantilla_normalizada.xlsx', await plantillaXlsx('NORMALIZADO'));
}

generar().catch((error) => {
  console.error('No fue posible generar las plantillas:', error);
  process.exit(1);
});
