'use client';

import dynamic from 'next/dynamic';
import ReplayControls from '../components/ReplayControls';
import SimulatorPanel from '../components/SimulatorPanel';

const TradingViewChart = dynamic(() => import('../components/TradingViewChart'), { ssr: false });

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 p-3 text-slate-100 sm:p-4">
      <section className="flex h-[calc(100dvh-1.5rem)] min-h-[32rem] flex-col gap-3 sm:h-[calc(100dvh-2rem)]">
        <ReplayControls />
        <div className="min-h-0 flex-1">
          <TradingViewChart />
        </div>
      </section>
      <SimulatorPanel />
    </main>
  );
}
