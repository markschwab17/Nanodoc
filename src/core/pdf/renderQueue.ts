/**
 * Global PDF render queue: run at most one mupdf render at a time and yield
 * to the event loop between jobs so the UI stays responsive (pan, zoom, scroll).
 */

type Job = () => Promise<void>;

const queue: Job[] = [];
let processing = false;

function processNext(): void {
  if (processing || queue.length === 0) return;
  const job = queue.shift()!;
  processing = true;
  job()
    .catch(() => {})
    .finally(() => {
      processing = false;
      if (queue.length > 0) {
        requestAnimationFrame(() => {
          setTimeout(processNext, 0);
        });
      }
    });
}

/**
 * Enqueue a render job. Jobs run one at a time; we yield (setTimeout 0) between
 * jobs so the main thread can process input and avoid freezing.
 */
export function enqueuePageRender(job: Job): void {
  queue.push(job);
  if (!processing) {
    setTimeout(processNext, 0);
  }
}

/**
 * Cancel any pending jobs for a given predicate (e.g. same page).
 * Call from effect cleanup so we don't run stale renders.
 */
export function cancelPageRenders(predicate: (job: Job) => boolean): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (predicate(queue[i])) {
      queue.splice(i, 1);
    }
  }
}
