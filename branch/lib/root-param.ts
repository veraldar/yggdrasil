/** The [root] segment of /roots/[root]/… as the computer's name (a bad escape stays as typed). */
export function rootOfParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
