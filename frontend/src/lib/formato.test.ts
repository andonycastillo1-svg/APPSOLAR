import { describe, expect, it } from 'vitest';
import {
  claseEstado,
  fecha,
  kwh,
  kwp,
  nombreMes,
  numero,
  porcentaje,
  quetzales,
  tarifa,
  textoEstado,
} from './formato';

/**
 * Formato de presentacion en español de Guatemala.
 * Estas reglas son visibles para el usuario en toda la aplicacion.
 */
describe('Formato de presentacion', () => {
  it('formatea numeros con separadores de Guatemala', () => {
    expect(numero(1234567.891, 2)).toBe('1,234,567.89');
    expect(numero(0, 2)).toBe('0.00');
    expect(numero(null)).toBe('—');
    expect(numero(undefined)).toBe('—');
    expect(numero('no es numero')).toBe('—');
  });

  it('etiqueta la energia SIEMPRE en kWh y la potencia SOLO en kWp', () => {
    expect(kwh(45200.5)).toBe('45,200.50 kWh');
    expect(kwh(null)).toBe('—');
    expect(kwp(1250)).toBe('1,250.000 kWp');
    // Un inversor sin potencia registrada no puede compararse por rendimiento.
    expect(kwp(null)).toBe('No registrada');
  });

  it('presenta la moneda en quetzales y distingue lo pendiente de tarifa', () => {
    expect(quetzales(12345.678)).toBe('Q 12,345.68');
    expect(quetzales(0)).toBe('Q 0.00');
    // Un valor nulo NO es cero: significa que aun no hay tarifa aprobada.
    expect(quetzales(null)).toBe('Pendiente de tarifa');
  });

  it('muestra la tarifa con la precision con la que se almacena', () => {
    expect(tarifa(1.234567)).toBe('Q 1.234567 / kWh');
    expect(tarifa(null)).toBe('Sin tarifa');
  });

  it('evita mostrar porcentajes sin base de comparacion', () => {
    expect(porcentaje(123.456)).toBe('123.46 %');
    expect(porcentaje(0)).toBe('0.00 %');
    expect(porcentaje(null)).toBe('Sin base de comparacion');
  });

  it('convierte las fechas ISO del API al formato visible dd/mm/aaaa', () => {
    expect(fecha('2026-08-21')).toBe('21/08/2026');
    expect(fecha('2026-01-05T00:00:00.000Z')).toBe('05/01/2026');
    expect(fecha(null)).toBe('—');
  });

  it('nombra los meses en español', () => {
    expect(nombreMes(1)).toBe('Enero');
    expect(nombreMes(12)).toBe('Diciembre');
  });

  it('asigna el color correcto a cada estado', () => {
    expect(claseEstado('APROBADA')).toContain('verde');
    expect(claseEstado('BORRADOR')).toContain('ambar');
    expect(claseEstado('PENDIENTE_DE_TARIFA')).toContain('ambar');
    expect(claseEstado('FALLIDA')).toContain('rojo');
    expect(claseEstado('MOCK')).toContain('azul');
  });

  it('traduce los estados tecnicos a texto legible', () => {
    expect(textoEstado('PENDIENTE_DE_TARIFA')).toBe('Pendiente de tarifa');
    expect(textoEstado('PROYECTO_CONSOLIDADO')).toBe('Consolidado del proyecto');
    expect(textoEstado('POR_INVERSOR')).toBe('Detalle por inversor');
    expect(textoEstado('HUAWEI_API')).toBe('Huawei SmartPVMS');
    expect(textoEstado('MOCK')).toBe('Simulado');
    expect(textoEstado(null)).toBe('—');
  });
});
