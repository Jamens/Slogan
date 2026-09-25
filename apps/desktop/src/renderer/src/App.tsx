import { useEffect, useState } from 'react';
// 注意层级：本文件在 src/renderer/src/，preload 在 src/preload/，要上跳两级。
import type { DajiaApi } from '../../preload/index';

declare global {
  interface Window {
    dajia: DajiaApi;
  }
}

export default function App(): React.JSX.Element {
  const [reply, setReply] = useState('未连接主进程');

  useEffect(() => {
    let alive = true;
    window.dajia
      .ping()
      .then((value) => {
        if (alive) setReply(value);
      })
      .catch((err: unknown) => {
        if (alive) setReply(`主进程无响应：${String(err)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>搭家</h1>
      <p>主进程应答：{reply}</p>
    </main>
  );
}
