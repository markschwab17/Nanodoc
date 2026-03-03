/**
 * Global PDF render queue: run at most one mupdf render at a time and yield
 * to the event loop between jobs so the UI stays responsive (pan, zoom, scroll).
 *
 * During rapid zoom/pan the queue can accumulate many stale renders. We process
 * the NEWEST job first (LIFO) and limit queue depth, but do NOT drop all jobs
 * so that multiple visible pages can still render.
 */

type Job = () => Promise<void>;

const queue: Job[] = [];
let processing = false;

/** Max queued jobs. Older jobs are dropped when this is exceeded. */
const MAX_QUEUE_SIZE = 8;

function processNext(): void {
  if (processing || queue.length === 0) return;

  // Take the most recent job (LIFO) so the latest zoom/pan state renders first
  const job = queue.pop()!;

  processing = true;
  job()
    .catch(() => {})
    .finally(() => {
      processing = false;
      if (queue.length > 0) {
        // Yield to the event loop so the browser can handle input events
        setTimeout(processNext, 0);
      }
    });
}

/**
 * Enqueue a render job. Jobs run one at a time; we yield (setTimeout 0) between
 * jobs so the main thread can process input and avoid freezing.
 *
 * If the queue exceeds MAX_QUEUE_SIZE, the oldest jobs are dropped since they
 * represent stale zoom levels that are no longer needed.
 */
export function enqueuePageRender(job: Job): void {
  queue.push(job);

  // Trim oldest jobs if we've exceeded the limit
  while (queue.length > MAX_QUEUE_SIZE) {
    queue.shift();
  }

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
