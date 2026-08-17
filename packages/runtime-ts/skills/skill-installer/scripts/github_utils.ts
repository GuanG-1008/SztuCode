export async function githubRequest(url: string, userAgent: string): Promise<Uint8Array> {
  const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN; if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export const githubApiContentsUrl = (repo: string, targetPath: string, ref: string) => `https://api.github.com/repos/${repo}/contents/${targetPath}?ref=${encodeURIComponent(ref)}`;
