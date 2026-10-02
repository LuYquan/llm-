/**
 * 常用串口硬件校验计算工具库 (M4 Step 4.3)
 * 支持 Modbus CRC16、CRC32、和校验 (Sum8)、异或校验 (XOR8)
 */

export function parseInputBytes(input: string, isHex: boolean): Uint8Array {
  if (isHex) {
    const cleaned = input.replace(/\s+/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      const hexPair = cleaned.slice(i, i + 2);
      const val = parseInt(hexPair, 16);
      if (!isNaN(val)) {
        bytes.push(val);
      }
    }
    return new Uint8Array(bytes);
  } else {
    return new TextEncoder().encode(input);
  }
}

/**
 * Modbus CRC16 (多项式 0xA001, 初值 0xFFFF, 低位在前高位在后)
 * 返回 HEX 字符串 (如 "C4 0B" 或 "4B 37")
 */
export function calcModbusCrc16(data: Uint8Array): { crc: number; hexLittleEndian: string; hexBigEndian: string } {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }

  const low = crc & 0xff;
  const high = (crc >> 8) & 0xff;

  const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return {
    crc,
    hexLittleEndian: `${toHex(low)} ${toHex(high)}`, // Modbus 标准：低字节在前
    hexBigEndian: `${toHex(high)} ${toHex(low)}`,
  };
}

/**
 * IEEE 802.3 标准 CRC32
 */
export function calcCrc32(data: Uint8Array): { crc: number; hex: string } {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    crc ^= byte;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc ^= 0xffffffff;
  const unsignedCrc = crc >>> 0;
  return {
    crc: unsignedCrc,
    hex: unsignedCrc.toString(16).padStart(8, '0').toUpperCase(),
  };
}

/**
 * 和校验 (Sum8: 所有字节求和取低 8 位)
 */
export function calcSum8(data: Uint8Array): { sum: number; hex: string } {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]) & 0xff;
  }
  return {
    sum,
    hex: sum.toString(16).padStart(2, '0').toUpperCase(),
  };
}

/**
 * 异或校验 (XOR8: 所有字节异或)
 */
export function calcXor8(data: Uint8Array): { xor: number; hex: string } {
  let xor = 0;
  for (let i = 0; i < data.length; i++) {
    xor ^= data[i];
  }
  return {
    xor,
    hex: xor.toString(16).padStart(2, '0').toUpperCase(),
  };
}
