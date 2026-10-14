import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatoLargoEs, ahoraLocal, ZONA_HORARIA } from '../utils/fechas';

/**
 * Generacion de documentos exportables.
 * Todo reporte incluye titulo, filtros aplicados, fecha de generacion, usuario
 * generador, unidades, moneda, zona horaria y notas sobre el origen de datos.
 */

export interface EncabezadoReporte {
  titulo: string;
  subtitulo?: string;
  empresa: string;
  usuario: string;
  filtros: Array<{ etiqueta: string; valor: string }>;
  notas: string[];
}

export interface TablaReporte {
  titulo?: string;
  columnas: Array<{ clave: string; titulo: string; ancho?: number; alineacion?: 'left' | 'right' }>;
  filas: Array<Record<string, unknown>>;
}

export interface IndicadorReporte {
  etiqueta: string;
  valor: string;
  detalle?: string;
}

const AZUL = '#0B3C5D';
const VERDE = '#1E8449';
const AMBAR = '#B7791F';
const GRIS = '#5B6770';

export function generarCsv(tabla: TablaReporte): string {
  const escapar = (valor: unknown) => `"${String(valor ?? '').replace(/"/g, '""')}"`;
  const lineas = [
    tabla.columnas.map((c) => escapar(c.titulo)).join(','),
    ...tabla.filas.map((fila) => tabla.columnas.map((c) => escapar(fila[c.clave])).join(',')),
  ];
  // BOM para que Excel reconozca UTF-8 correctamente.
  return '﻿' + lineas.join('\r\n');
}

export async function generarXlsx(
  encabezado: EncabezadoReporte,
  indicadores: IndicadorReporte[],
  tablas: TablaReporte[],
): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = encabezado.empresa;
  libro.created = new Date();

  const portada = libro.addWorksheet('Resumen');
  portada.columns = [{ width: 38 }, { width: 46 }];
  portada.addRow([encabezado.titulo]).font = { bold: true, size: 15, color: { argb: 'FF0B3C5D' } };
  if (encabezado.subtitulo) portada.addRow([encabezado.subtitulo]);
  portada.addRow([]);
  portada.addRow(['Empresa', encabezado.empresa]);
  portada.addRow(['Generado por', encabezado.usuario]);
  portada.addRow(['Fecha de generacion', ahoraLocal()]);
  portada.addRow(['Zona horaria', ZONA_HORARIA]);
  portada.addRow(['Moneda', 'GTQ (Q)']);
  portada.addRow(['Unidad de energia', 'kWh']);
  portada.addRow([]);
  portada.addRow(['FILTROS APLICADOS']).font = { bold: true };
  for (const filtro of encabezado.filtros) portada.addRow([filtro.etiqueta, filtro.valor]);
  portada.addRow([]);
  portada.addRow(['INDICADORES']).font = { bold: true };
  for (const indicador of indicadores) {
    portada.addRow([indicador.etiqueta, indicador.valor + (indicador.detalle ? ` (${indicador.detalle})` : '')]);
  }
  portada.addRow([]);
  portada.addRow(['NOTAS']).font = { bold: true };
  for (const nota of encabezado.notas) portada.addRow([nota]);

  tablas.forEach((tabla, indice) => {
    const hoja = libro.addWorksheet((tabla.titulo ?? `Detalle ${indice + 1}`).slice(0, 30));
    hoja.columns = tabla.columnas.map((c) => ({
      header: c.titulo,
      key: c.clave,
      width: c.ancho ?? 18,
    }));
    tabla.filas.forEach((fila) => hoja.addRow(fila));
    const cabecera = hoja.getRow(1);
    cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C5D' } };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
  });

  return Buffer.from(await libro.xlsx.writeBuffer());
}

/**
 * Libro de Excel del inventario de proyectos.
 *
 * La primera hoja es EXACTAMENTE la tabla que ve la persona en pantalla
 * (mismas columnas, mismo orden, fila de TOTAL al final), con formato numerico
 * para que se pueda sumar y filtrar. El resto de hojas son el detalle.
 */
export async function generarXlsxInventario(
  encabezado: EncabezadoReporte,
  indicadores: IndicadorReporte[],
  principal: TablaReporte,
  detalle: TablaReporte[],
): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = encabezado.empresa;
  libro.created = new Date();

  const FORMATOS: Record<string, string> = {
    grupos: '#,##0',
    inversores: '#,##0',
    paneles: '#,##0',
    potencia_kwp: '#,##0.00',
    produccion_kwh: '#,##0.00',
    valor_q: '"Q" #,##0.00',
  };
  const AZUL_ARGB = 'FF1C4F90';

  const hoja = libro.addWorksheet('Inventario', { views: [{ state: 'frozen', ySplit: 4 }] });
  hoja.columns = principal.columnas.map((c) => ({ key: c.clave, width: c.ancho ?? 16 }));

  const ultima = principal.columnas.length;
  hoja.mergeCells(1, 1, 1, ultima);
  const titulo = hoja.getCell(1, 1);
  titulo.value = `${encabezado.titulo}${encabezado.subtitulo ? ' - ' + encabezado.subtitulo : ''}`;
  titulo.font = { bold: true, size: 14, color: { argb: AZUL_ARGB } };
  hoja.mergeCells(2, 1, 2, ultima);
  hoja.getCell(2, 1).value =
    `${encabezado.empresa} | Generado por ${encabezado.usuario} | ${ahoraLocal()} (${ZONA_HORARIA}) | ` +
    encabezado.filtros.map((f) => `${f.etiqueta}: ${f.valor}`).join(' | ');
  hoja.getCell(2, 1).font = { size: 9, color: { argb: 'FF5B6770' } };

  // Fila 4: encabezado de la tabla (la 3 queda como separador).
  const cabecera = hoja.getRow(4);
  principal.columnas.forEach((c, i) => {
    const celda = cabecera.getCell(i + 1);
    celda.value = c.titulo;
    celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_ARGB } };
    celda.alignment = { horizontal: c.alineacion === 'right' ? 'right' : 'left', vertical: 'middle', wrapText: true };
  });
  cabecera.height = 24;

  principal.filas.forEach((fila, indice) => {
    const esTotal = String(fila.cliente) === 'TOTAL';
    const r = hoja.getRow(5 + indice);
    principal.columnas.forEach((c, i) => {
      const celda = r.getCell(i + 1);
      const valor = fila[c.clave];
      celda.value = valor === undefined || valor === null ? '' : (valor as ExcelJS.CellValue);
      if (typeof valor === 'number' && FORMATOS[c.clave]) celda.numFmt = FORMATOS[c.clave];
      celda.alignment = { horizontal: c.alineacion === 'right' ? 'right' : 'left', vertical: 'middle' };
      celda.border = { bottom: { style: 'thin', color: { argb: 'FFE3E9ED' } } };
      if (esTotal) {
        celda.font = { bold: true };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE8F5' } };
        celda.border = { top: { style: 'medium', color: { argb: AZUL_ARGB } } };
      }
    });
    // Registros sin tarifa: se avisa en una nota de la celda de valor.
    const pendientes = Number(fila.pendientes ?? 0);
    if (!esTotal && pendientes > 0) {
      const posicion = principal.columnas.findIndex((c) => c.clave === 'valor_q');
      if (posicion >= 0) {
        r.getCell(posicion + 1).note = `${pendientes} registro(s) sin tarifa: monto parcial`;
        r.getCell(posicion + 1).font = { color: { argb: 'FFB7791F' }, bold: true };
      }
    }
  });
  const ultimaFila = 4 + principal.filas.length;
  hoja.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, ultimaFila - 1), column: ultima } };

  // Hojas de detalle
  detalle.forEach((tabla, indice) => {
    const h = libro.addWorksheet((tabla.titulo ?? `Detalle ${indice + 1}`).slice(0, 30));
    h.columns = tabla.columnas.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho ?? 18 }));
    tabla.filas.forEach((f) => h.addRow(f));
    const cab = h.getRow(1);
    cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_ARGB } };
    h.views = [{ state: 'frozen', ySplit: 1 }];
  });

  // Resumen y notas al final
  const resumen = libro.addWorksheet('Resumen y notas');
  resumen.columns = [{ width: 34 }, { width: 60 }];
  resumen.addRow([encabezado.titulo]).font = { bold: true, size: 14, color: { argb: AZUL_ARGB } };
  resumen.addRow([]);
  for (const f of encabezado.filtros) resumen.addRow([f.etiqueta, f.valor]);
  resumen.addRow([]);
  resumen.addRow(['TOTALES']).font = { bold: true };
  for (const i of indicadores) resumen.addRow([i.etiqueta, i.valor + (i.detalle ? ` (${i.detalle})` : '')]);
  resumen.addRow([]);
  resumen.addRow(['NOTAS']).font = { bold: true };
  for (const n of encabezado.notas) resumen.addRow([n]);

  return Buffer.from(await libro.xlsx.writeBuffer());
}

export function generarPdf(
  encabezado: EncabezadoReporte,
  indicadores: IndicadorReporte[],
  tablas: TablaReporte[],
): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    const documento = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
    const partes: Buffer[] = [];

    documento.on('data', (parte: Buffer) => partes.push(parte));
    documento.on('end', () => resolver(Buffer.concat(partes)));
    documento.on('error', rechazar);

    const anchoUtil = documento.page.width - 80;

    // --- Encabezado ---
    documento.rect(40, 40, anchoUtil, 4).fill(AZUL);
    documento.moveDown(0.6);
    documento.fillColor(AZUL).fontSize(16).font('Helvetica-Bold').text(encabezado.titulo, 40, 55);
    if (encabezado.subtitulo) {
      documento.fillColor(GRIS).fontSize(10).font('Helvetica').text(encabezado.subtitulo);
    }
    documento.moveDown(0.4);
    documento
      .fillColor(GRIS)
      .fontSize(8)
      .text(
        `${encabezado.empresa}  |  Generado por: ${encabezado.usuario}  |  ${ahoraLocal()} (${ZONA_HORARIA})  |  Moneda: GTQ (Q)  |  Energia: kWh`,
      );

    // --- Filtros ---
    documento.moveDown(0.8);
    documento.fillColor(AZUL).fontSize(10).font('Helvetica-Bold').text('Filtros aplicados');
    documento.fillColor('#222').fontSize(9).font('Helvetica');
    for (const filtro of encabezado.filtros) {
      documento.text(`- ${filtro.etiqueta}: ${filtro.valor}`);
    }

    // --- Indicadores ---
    if (indicadores.length > 0) {
      documento.moveDown(0.7);
      documento.fillColor(AZUL).fontSize(10).font('Helvetica-Bold').text('Indicadores');
      documento.moveDown(0.3);

      const columnas = 3;
      const anchoTarjeta = anchoUtil / columnas - 6;
      let x = 40;
      let y = documento.y;

      indicadores.forEach((indicador, indice) => {
        if (indice > 0 && indice % columnas === 0) {
          x = 40;
          y += 48;
        }
        documento.roundedRect(x, y, anchoTarjeta, 42, 4).fillAndStroke('#F4F7F9', '#D8E0E6');
        documento.fillColor(GRIS).fontSize(7).font('Helvetica').text(indicador.etiqueta, x + 8, y + 7, {
          width: anchoTarjeta - 16,
        });
        documento.fillColor(VERDE).fontSize(12).font('Helvetica-Bold').text(indicador.valor, x + 8, y + 19, {
          width: anchoTarjeta - 16,
        });
        if (indicador.detalle) {
          documento.fillColor(AMBAR).fontSize(6).font('Helvetica').text(indicador.detalle, x + 8, y + 33, {
            width: anchoTarjeta - 16,
          });
        }
        x += anchoTarjeta + 9;
      });

      documento.y = y + 52;
      documento.x = 40;
    }

    // --- Tablas ---
    for (const tabla of tablas) {
      if (documento.y > documento.page.height - 140) documento.addPage();

      documento.moveDown(0.5);
      if (tabla.titulo) {
        documento.fillColor(AZUL).fontSize(10).font('Helvetica-Bold').text(tabla.titulo, 40, documento.y);
        documento.moveDown(0.3);
      }

      const totalPeso = tabla.columnas.reduce((acc, c) => acc + (c.ancho ?? 1), 0);
      const anchos = tabla.columnas.map((c) => ((c.ancho ?? 1) / totalPeso) * anchoUtil);

      const dibujarCabecera = () => {
        const y = documento.y;
        documento.rect(40, y, anchoUtil, 16).fill(AZUL);
        let x = 40;
        tabla.columnas.forEach((columna, indice) => {
          documento
            .fillColor('#FFFFFF')
            .fontSize(7.5)
            .font('Helvetica-Bold')
            .text(columna.titulo, x + 3, y + 4.5, {
              width: anchos[indice] - 6,
              align: columna.alineacion ?? 'left',
              lineBreak: false,
            });
          x += anchos[indice];
        });
        documento.y = y + 16;
      };

      dibujarCabecera();

      tabla.filas.forEach((fila, indiceFila) => {
        if (documento.y > documento.page.height - 60) {
          documento.addPage();
          dibujarCabecera();
        }
        const y = documento.y;
        if (indiceFila % 2 === 1) documento.rect(40, y, anchoUtil, 14).fill('#F7F9FA');

        let x = 40;
        tabla.columnas.forEach((columna, indice) => {
          documento
            .fillColor('#222222')
            .fontSize(7.5)
            .font('Helvetica')
            .text(String(fila[columna.clave] ?? ''), x + 3, y + 3.5, {
              width: anchos[indice] - 6,
              align: columna.alineacion ?? 'left',
              lineBreak: false,
            });
          x += anchos[indice];
        });
        documento.y = y + 14;
      });
    }

    // --- Notas ---
    if (encabezado.notas.length > 0) {
      if (documento.y > documento.page.height - 110) documento.addPage();
      documento.moveDown(0.8);
      documento.fillColor(AZUL).fontSize(9).font('Helvetica-Bold').text('Notas sobre el origen de los datos', 40);
      documento.fillColor(GRIS).fontSize(7.5).font('Helvetica');
      for (const nota of encabezado.notas) documento.text(`- ${nota}`, { width: anchoUtil });
    }

    // --- Pie con numeracion ---
    const rango = documento.bufferedPageRange();
    for (let i = 0; i < rango.count; i += 1) {
      documento.switchToPage(rango.start + i);
      documento
        .fillColor(GRIS)
        .fontSize(7)
        .font('Helvetica')
        .text(
          `${encabezado.empresa} - Sistema Centralizado de Monitoreo Energetico   |   Pagina ${i + 1} de ${rango.count}`,
          40,
          documento.page.height - 32,
          { width: anchoUtil, align: 'center' },
        );
    }

    documento.end();
  });
}

export function formatearFechaCorta(iso: string | null | undefined): string {
  if (!iso) return 'Sin datos';
  return formatoLargoEs(String(iso));
}
