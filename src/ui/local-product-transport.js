import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createLocalBatchCoordinator } from './local-batch-coordinator.js';

const PLATFORM_ORDER = ['kimi', 'yuanbao', 'deepseek'];

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}

function exportResponse(batchId, body) {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="observation-batch-${batchId}.json"`
    },
    body
  };
}

function artifactContentType(path) {
  return { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' }[extname(path)] ?? 'application/octet-stream';
}

function artifactPath(localPath) {
  if (typeof localPath !== 'string' || !localPath || isAbsolute(localPath)) throw new Error('Artifact path is invalid.');
  const root = resolve(process.cwd());
  const resolved = resolve(root, localPath);
  const fromRoot = relative(root, resolved);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Artifact path is outside the local Product UI data root.');
  return resolved;
}

function parseBody(request) {
  return request.body && typeof request.body === 'object' ? request.body : {};
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required.`);
  return value.trim();
}

function projectInput(body) {
  const selected = Array.isArray(body.selected_platforms) ? body.selected_platforms : PLATFORM_ORDER;
  if (selected.length === 0 || selected.some((platform) => !PLATFORM_ORDER.includes(platform)) || new Set(selected).size !== selected.length) {
    throw new Error('Only Kimi, 腾讯元宝, and DeepSeek can be selected.');
  }
  return {
    name: requiredText(body.name, 'Project name'),
    brand_name: requiredText(body.brand_name, 'Brand'),
    brand_aliases: Array.isArray(body.brand_aliases) ? body.brand_aliases.filter(Boolean).map(String) : [],
    competitors: Array.isArray(body.competitors) ? body.competitors.filter((item) => item?.name).map((item) => ({ name: String(item.name).trim(), aliases: Array.isArray(item.aliases) ? item.aliases.filter(Boolean).map(String) : [] })) : [],
    selected_platforms: selected
  };
}

function projectView(app, projectId) {
  const project = app.getProject(projectId);
  if (!project) return null;
  const promptSets = app.listPromptSets(projectId).map((promptSet) => ({
    ...promptSet,
    prompts: app.listPrompts(promptSet.prompt_set_id)
  }));
  const primaryPromptSet = promptSets[0] ?? null;
  return { project, monitoring_prompts: primaryPromptSet?.prompts ?? [], has_additional_prompt_sets: promptSets.length > 1 };
}

export function createLocalProductTransport({ app, staticRoot, batchCoordinator = createLocalBatchCoordinator({ app }) }) {
  return async function handle(request) {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (path === '/api/projects' && method === 'GET') {
        return jsonResponse(200, app.listProjects().map((project) => ({
          ...project,
          prompt_count: app.listPromptSets(project.project_id).reduce((count, set) => count + app.listPrompts(set.prompt_set_id).length, 0)
        })));
      }
      if (path === '/api/projects' && method === 'POST') return jsonResponse(201, app.createProject(projectInput(parseBody(request))));
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === 'GET') {
        const view = projectView(app, projectMatch[1]);
        return view ? jsonResponse(200, view) : jsonResponse(404, { error: 'Project not found.' });
      }
      if (projectMatch && method === 'PATCH') return jsonResponse(200, app.updateProject(projectMatch[1], projectInput(parseBody(request))));
      const previewMatch = path.match(/^\/api\/projects\/([^/]+)\/run-preview$/);
      if (previewMatch && method === 'GET') return jsonResponse(200, app.getProjectBatchPreview(previewMatch[1]));
      const createBatchMatch = path.match(/^\/api\/projects\/([^/]+)\/batches$/);
      if (createBatchMatch && method === 'GET') return jsonResponse(200, app.listProjectBatchHistory(createBatchMatch[1]));
      if (createBatchMatch && method === 'POST') return jsonResponse(202, batchCoordinator.createAndStart(createBatchMatch[1]));
      const setMatch = path.match(/^\/api\/projects\/([^/]+)\/prompt-sets$/);
      if (setMatch && method === 'POST') {
        const body = parseBody(request);
        return jsonResponse(201, app.createPromptSet({ project_id: setMatch[1], name: requiredText(body.name, 'Prompt Set name') }));
      }
      const projectPromptMatch = path.match(/^\/api\/projects\/([^/]+)\/prompts$/);
      if (projectPromptMatch && method === 'POST') {
        const body = parseBody(request);
        return jsonResponse(201, app.addProjectPrompt(projectPromptMatch[1], { label: body.label?.trim() || null, text: requiredText(body.text, 'Prompt') }));
      }
      const promptMatch = path.match(/^\/api\/prompt-sets\/([^/]+)\/prompts$/);
      if (promptMatch && method === 'POST') {
        const body = parseBody(request);
        const prompts = app.listPrompts(promptMatch[1]);
        return jsonResponse(201, app.addPrompt({ prompt_set_id: promptMatch[1], label: body.label?.trim() || null, text: requiredText(body.text, 'Prompt'), position: prompts.length }));
      }
      const promptEditMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
      if (promptEditMatch && method === 'PATCH') {
        const body = parseBody(request);
        return jsonResponse(200, app.updatePrompt(promptEditMatch[1], { label: body.label?.trim() || null, text: requiredText(body.text, 'Prompt') }));
      }
      const batchMatch = path.match(/^\/api\/batches\/([^/]+)$/);
      if (batchMatch && method === 'GET') {
        const batch = app.getBatchStatus(batchMatch[1]);
        return batch ? jsonResponse(200, { batch, plans: app.listBatchRunPlans(batchMatch[1]) }) : jsonResponse(404, { error: 'Batch not found.' });
      }
      const resultMatch = path.match(/^\/api\/batches\/([^/]+)\/result$/);
      if (resultMatch && method === 'GET') {
        const result = app.getBatchResult(resultMatch[1]);
        return result ? jsonResponse(200, result) : jsonResponse(404, { error: 'Batch not found.' });
      }
      const exportMatch = path.match(/^\/api\/batches\/([^/]+)\/export$/);
      if (exportMatch && method === 'GET') return exportResponse(exportMatch[1], app.exportBatchResult(exportMatch[1]));
      const resumeMatch = path.match(/^\/api\/batches\/([^/]+)\/resume$/);
      if (resumeMatch && method === 'POST') return jsonResponse(202, batchCoordinator.resume(resumeMatch[1]));
      const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)\/content$/);
      if (artifactMatch && method === 'GET') {
        const artifact = app.getArtifact(artifactMatch[1]);
        if (!artifact) return jsonResponse(404, { error: 'Artifact not found.' });
        const artifactFile = artifactPath(artifact.path);
        try { return { status: 200, headers: { 'content-type': artifactContentType(artifactFile) }, body: await readFile(artifactFile) }; }
        catch { return jsonResponse(404, { error: 'Artifact file is unavailable locally.' }); }
      }
      if (method === 'GET' && staticRoot) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const safe = join(staticRoot, file);
        if (!safe.startsWith(join(staticRoot))) return jsonResponse(400, { error: 'Invalid path.' });
        try {
          return { status: 200, headers: { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(safe)] ?? 'application/octet-stream' }, body: await readFile(safe) };
        } catch { return jsonResponse(404, { error: 'Not found.' }); }
      }
      return jsonResponse(404, { error: 'Not found.' });
    } catch (error) {
      return jsonResponse(error.status ?? 400, { error: error.message });
    }
  };
}
