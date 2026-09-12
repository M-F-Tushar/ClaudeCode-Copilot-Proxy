import { Response } from 'express';

/** Resolve false on disconnect, including while waiting for backpressure. */
export async function writeResponse(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) {
    return false;
  }
  if (res.write(chunk)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
    if (res.destroyed || res.writableEnded) {
      onClose();
    }
  });
}

export function abortOnDisconnect(res: Response): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onClose);
  if (res.destroyed) {
    onClose();
  }
  return {
    signal: controller.signal,
    cleanup: () => res.removeListener('close', onClose),
  };
}
