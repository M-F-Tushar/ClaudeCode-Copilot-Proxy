import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { logger } from './logger.js';

let cachedMachineId: string | undefined;

/**
 * Generate a deterministic machine ID based on network MAC address.
 * Falls back to a UUID if no valid MAC address is found.
 * 
 * @returns {string} A SHA-256 hash of the MAC address or a UUID
 */
export function getMachineId(): string {
  if (cachedMachineId) {
    return cachedMachineId;
  }
  try {
    const interfaces = networkInterfaces();
    const invalidMacAddresses = new Set(['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff']);
    
    for (const interfaceName in interfaces) {
      const networkInterface = interfaces[interfaceName];
      
      if (networkInterface) {
        for (const { mac } of networkInterface) {
          if (mac && !invalidMacAddresses.has(mac)) {
            // Use MAC address as a seed for a deterministic machine ID
            cachedMachineId = crypto.createHash('sha256').update(mac, 'utf8').digest('hex');
            return cachedMachineId;
          }
        }
      }
    }
    
    // No valid MAC address found, fall back to UUID
    logger.warn('No valid MAC address found for machine ID, using UUID instead');
    cachedMachineId = crypto.randomUUID();
    return cachedMachineId;
  } catch (error) {
    logger.error('Error generating machine ID:', error);
    cachedMachineId = crypto.randomUUID();
    return cachedMachineId;
  }
}
