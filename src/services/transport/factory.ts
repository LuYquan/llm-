/**
 * 传输驱动工厂与宿主环境嗅探器 (TransportFactory)
 * 依据官方 isTauri()、window.isSecureContext 及浏览器能力嗅探，动态按需加载对应的 ISerialTransport 实现
 */

import { isTauri } from '@tauri-apps/api/core';
import type { ISerialTransport } from './types';
import { UnsupportedTransport } from './unsupported-transport';

export class TransportFactory {
  /**
   * 判断当前运行环境是否为 Tauri 桌面容器宿主
   * 严格使用官方 isTauri() API，不依赖内部私有变量
   */
  static isTauri(): boolean {
    return isTauri();
  }

  /**
   * 判断当前环境是否处于安全上下文 (HTTPS 或 localhost)
   */
  static isSecureContext(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.isSecureContext === true;
  }

  /**
   * 判断当前环境是否支持 Chromium Web Serial API
   */
  static isWebSerialSupported(): boolean {
    return (
      this.isSecureContext() &&
      typeof navigator !== 'undefined' &&
      'serial' in navigator &&
      typeof (navigator as any).serial?.getPorts === 'function'
    );
  }

  /**
   * 根据当前宿主环境动态按需创建并返回最适传输实例
   */
  static async create(): Promise<ISerialTransport> {
    // 1. 若处于 Tauri 桌面端环境，动态引入 TauriTransport
    if (this.isTauri()) {
      try {
        const { TauriTransport } = await import('./tauri-transport');
        return new TauriTransport();
      } catch (err) {
        console.error('[TransportFactory] 加载 TauriTransport 模块失败:', err);
        return new UnsupportedTransport(`加载桌面端串口驱动失败: ${err}`);
      }
    }

    // 2. 若处于支持 Web Serial 的浏览器环境，动态加载 WebSerialTransport
    if (this.isWebSerialSupported()) {
      try {
        const { WebSerialTransport } = await import('./web-serial-transport');
        return new WebSerialTransport();
      } catch (err) {
        console.error('[TransportFactory] 加载 WebSerialTransport 模块失败:', err);
        return new UnsupportedTransport(`加载浏览器 Web Serial 串口驱动失败: ${err}`);
      }
    }

    // 3. 既非桌面端，又不支持 Web Serial
    if (typeof window !== 'undefined' && !this.isSecureContext()) {
      return new UnsupportedTransport(
        '当前处于非安全上下文 (HTTP)。Web Serial API 要求必须在 HTTPS 或 localhost 环境下运行。'
      );
    }

    return new UnsupportedTransport(
      '当前环境不支持 Web Serial 串口通信。请使用桌面客户端，或在桌面端使用最新版 Google Chrome / Microsoft Edge 浏览器访问。'
    );
  }
}

/**
 * 便捷工厂函数别名
 */
export async function createTransport(): Promise<ISerialTransport> {
  return TransportFactory.create();
}
