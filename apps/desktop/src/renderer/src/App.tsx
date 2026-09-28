import type { DajiaApi } from '../../preload/index';
import { PlanCanvas } from './PlanCanvas';

declare global {
  interface Window {
    dajia: DajiaApi;
  }
}

export default function App(): React.JSX.Element {
  return <PlanCanvas />;
}
