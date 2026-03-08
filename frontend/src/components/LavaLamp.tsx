import { useBlobsEnabled } from '../utils/theme';

export default function LavaLamp() {
  if (!useBlobsEnabled()) return null;

  return (
    <div className="lava-lamp">
      <div className="lava-blob lava-blob-1" />
      <div className="lava-blob lava-blob-2" />
      <div className="lava-blob lava-blob-3" />
      <div className="lava-blob lava-blob-4" />
      <div className="lava-blob lava-blob-5" />
      <div className="lava-blob lava-blob-6" />
      <div className="lava-glow" />
    </div>
  );
}
