'use client';

/** /roots/[root]/artifacts — that computer's artifacts: the /artifacts page itself, scoped to it
 *  (components/app/artifacts-screen), opened from the artifacts key of its own page. */
import { use } from 'react';
import { ArtifactsScreen } from '@/components/app/artifacts-screen';
import { rootOfParam } from '@/lib/root-param';

export default function RootArtifactsPage({ params }: { params: Promise<{ root: string }> }) {
  const root = rootOfParam(use(params).root);
  return <ArtifactsScreen key={root} root={root} />;
}
