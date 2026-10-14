// Publishes the count files to a branch of a GitHub repository, so the analytics page on
// GitHub Pages can read them from raw.githubusercontent.com.
// Each publish replaces the branch with a single new commit (no growing history), so the
// repository stays small even after years of hourly updates.
const API = 'https://api.github.com';

export class GitHubPublisher {
  /**
   * @param {object} o
   * @param {string} o.repo 'owner/name'
   * @param {string} o.branch e.g. 'data'
   * @param {string} o.token fine-grained token with Contents: read & write on that repo
   * @param {string} [o.prefix] folder inside the branch, default 'counts'
   */
  constructor(o) {
    this.repo = o.repo;
    this.branch = o.branch || 'data';
    this.token = o.token;
    this.prefix = (o.prefix ?? 'counts').replace(/^\/|\/$/g, '');
  }

  get rawBase() {
    return `https://raw.githubusercontent.com/${this.repo}/${this.branch}/${this.prefix ? `${this.prefix}/` : ''}`;
  }

  async call(method, path, body) {
    const res = await fetch(`${API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'car-counter-station',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** files: {relativePath: textContent} */
  async publish(files, message = 'Update counts') {
    const ref = await this.call('GET', `/git/ref/heads/${this.branch}`);
    let baseTree;
    if (ref) baseTree = (await this.call('GET', `/git/commits/${ref.object.sha}`)).tree.sha;
    const tree = await this.call('POST', '/git/trees', {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: Object.entries(files).map(([path, content]) => ({
        path: this.prefix ? `${this.prefix}/${path}` : path,
        mode: '100644',
        type: 'blob',
        content,
      })),
    });
    const commit = await this.call('POST', '/git/commits', { message, tree: tree.sha, parents: [] });
    if (ref) await this.call('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit.sha, force: true });
    else await this.call('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: commit.sha });
    return commit.sha;
  }
}
