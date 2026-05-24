import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import { getKcForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ALLOWED_COMMANDS = new Set([
    'ls', 'ls -la', 'ls -l',
    'cat /etc/os-release',
    'env', 'ps', 'ps aux',
    'df', 'df -h',
    'free', 'free -h',
    'uname -a', 'id', 'pwd', 'date',
]);
const execBodySchema = z.object({
    namespace: z.string().min(1).max(63).regex(K8S_NAME_RE, 'Invalid namespace name'),
    pod: z.string().min(1).max(253).regex(K8S_NAME_RE, 'Invalid pod name'),
    container: z.string().min(1).max(253).regex(K8S_NAME_RE, 'Invalid container name'),
    command: z.string().min(1).max(200),
});
async function execInPod(kc, namespace, pod, container, command) {
    const exec = new k8s.Exec(kc);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outChunks = [];
    const errChunks = [];
    stdout.on('data', (chunk) => outChunks.push(chunk));
    stderr.on('data', (chunk) => errChunks.push(chunk));
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('exec timeout')), 15_000);
        exec.exec(namespace, pod, container, command, stdout, stderr, null, false, (status) => {
            clearTimeout(timeout);
            if (status.status === 'Failure')
                reject(new Error(status.message ?? 'exec failed'));
            else
                resolve();
        }).catch((err) => { clearTimeout(timeout); reject(err); });
    });
    return {
        output: Buffer.concat(outChunks).toString('utf-8'),
        error: errChunks.length > 0 ? Buffer.concat(errChunks).toString('utf-8') : null,
    };
}
export const execRoute = new Hono();
execRoute.post('/', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin'))
        return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const parsed = execBodySchema.safeParse(body);
    if (!parsed.success)
        return c.json({ error: parsed.error.flatten() }, 400);
    const { namespace, pod, container, command } = parsed.data;
    if (!ALLOWED_COMMANDS.has(command))
        return c.json({ error: 'Command not allowed' }, 403);
    try {
        const kc = await getKcForCluster(user.clusterId);
        const result = await execInPod(kc, namespace, pod, container, command.split(/\s+/));
        return c.json(result);
    }
    catch (err) {
        return c.json({ output: '', error: err instanceof Error ? err.message : 'exec failed' }, 500);
    }
});
//# sourceMappingURL=exec.js.map