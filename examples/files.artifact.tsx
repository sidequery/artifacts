import { Button, H1, Stack, Text, artifactFiles, useState, useEffect, type ArtifactFile } from "sidequery/artifacts";

export default function Files() {
  const [files, setFiles] = useState<ArtifactFile[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setFiles((await artifactFiles.list()).files); };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await refresh(); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, []);
  return <Stack>
    <H1>Artifact files</H1>
    <Text>Files stay with this artifact. Maximum 25 MiB per file.</Text>
    <input aria-label="Upload file" type="file" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void run(() => artifactFiles.upload(file));
    }} />
    {files.map(file => <Stack key={file.id}>
      <Text>{file.name} ({file.size} bytes)</Text>
      <Button disabled={busy} onClick={() => { void run(() => artifactFiles.download(file.id)); }}>Download {file.name}</Button>
      <Button disabled={busy} onClick={() => { void run(() => artifactFiles.delete(file.id)); }}>Delete {file.name}</Button>
    </Stack>)}
    {message ? <Text>{message}</Text> : null}
  </Stack>;
}
