'use client';

/** /providers — standalone view of the root's providers block (also embedded on /agents and
 *  /roots/[root]/settings). */
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { ProvidersBlock } from '@/components/providers-block';

export default function ProvidersPage() {
  const router = useRouter();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <button onClick={() => router.back()} className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </button>
        <span className="text-[13px]">providers</span>
      </header>
      <ProvidersBlock />
    </main>
  );
}
