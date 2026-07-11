/**
 * queue.js — Background job queue for async operations
 * Uses simple in-memory queue with optional Redis backing
 * Handles: SMS sending, email notifications, report generation, cleanup tasks
 */
require('dotenv').config();

const smsService = require('./services/sms');

// ── Job Queue Storage ─────────────────────────────────────────────────────────
const jobQueue = [];
const processingJobs = new Map();
const completedJobs = new Map();
const failedJobs = new Map();

let isProcessing = false;
const MAX_COMPLETED_HISTORY = 100;
const MAX_FAILED_HISTORY = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

// ── Job Processor ─────────────────────────────────────────────────────────────
async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  
  isProcessing = true;
  
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    
    if (!job || !job.id) continue;
    
    processingJobs.set(job.id, {
      ...job,
      startedAt: Date.now(),
      status: 'processing',
    });
    
    try {
      console.log(`[Queue] Processing job ${job.id} (${job.type})`);
      
      let result;
      switch (job.type) {
        case 'sms':
          result = await handleSMSJob(job);
          break;
        case 'bulk-sms':
          result = await handleBulkSMSJob(job);
          break;
        case 'cleanup':
          result = await handleCleanupJob(job);
          break;
        case 'report':
          result = await handleReportJob(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      
      // Job succeeded
      processingJobs.delete(job.id);
      completedJobs.set(job.id, {
        ...job,
        result,
        completedAt: Date.now(),
        status: 'completed',
      });
      
      // Limit completed history
      if (completedJobs.size > MAX_COMPLETED_HISTORY) {
        const oldestKey = completedJobs.keys().next().value;
        completedJobs.delete(oldestKey);
      }
      
      console.log(`[Queue] ✅ Job ${job.id} completed`);
      
    } catch (error) {
      console.error(`[Queue] ❌ Job ${job.id} failed:`, error.message);
      
      // Handle retry logic
      const retries = job.retries || 0;
      if (retries < MAX_RETRIES) {
        console.log(`[Queue] 🔄 Retrying job ${job.id} (attempt ${retries + 1}/${MAX_RETRIES})`);
        
        // Re-queue with delay
        setTimeout(() => {
          jobQueue.push({
            ...job,
            retries: retries + 1,
          });
          processQueue();
        }, RETRY_DELAY * (retries + 1));
      } else {
        // Max retries exceeded
        processingJobs.delete(job.id);
        failedJobs.set(job.id, {
          ...job,
          error: error.message,
          failedAt: Date.now(),
          status: 'failed',
        });
        
        // Limit failed history
        if (failedJobs.size > MAX_FAILED_HISTORY) {
          const oldestKey = failedJobs.keys().next().value;
          failedJobs.delete(oldestKey);
        }
      }
    }
  }
  
  isProcessing = false;
}

// ── Job Handlers ──────────────────────────────────────────────────────────────

async function handleSMSJob(job) {
  const { to, message } = job.data;
  return await smsService.sendSMS(to, message);
}

async function handleBulkSMSJob(job) {
  const { recipients } = job.data;
  return await smsService.sendBulkSMS(recipients);
}

async function handleCleanupJob(job) {
  // Placeholder for file cleanup, cache cleanup, etc.
  console.log('[Queue] Running cleanup job:', job.data);
  return { cleaned: 0 };
}

async function handleReportJob(job) {
  // Placeholder for async report generation
  console.log('[Queue] Generating report:', job.data);
  return { generated: true };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a job to the queue
 * @param {string} type - Job type (sms, bulk-sms, cleanup, report)
 * @param {object} data - Job data
 * @param {object} options - Job options (priority, delay, etc.)
 * @returns {string} Job ID
 */
function addJob(type, data, options = {}) {
  const jobId = `${type}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  const job = {
    id: jobId,
    type,
    data,
    priority: options.priority || 0,
    delay: options.delay || 0,
    retries: 0,
    createdAt: Date.now(),
    status: 'queued',
  };
  
  if (job.delay > 0) {
    // Delayed job
    setTimeout(() => {
      jobQueue.push(job);
      jobQueue.sort((a, b) => b.priority - a.priority);
      processQueue();
    }, job.delay);
  } else {
    // Immediate job
    jobQueue.push(job);
    jobQueue.sort((a, b) => b.priority - a.priority);
    
    // Start processing if not already running
    if (!isProcessing) {
      setImmediate(processQueue);
    }
  }
  
  console.log(`[Queue] Job ${jobId} added (${type})`);
  return jobId;
}

/**
 * Add SMS job to queue
 * @param {string} to - Recipient phone number
 * @param {string} message - SMS message
 * @returns {string} Job ID
 */
function queueSMS(to, message) {
  return addJob('sms', { to, message }, { priority: 10 });
}

/**
 * Add bulk SMS job to queue
 * @param {Array} recipients - Array of {phone, message, context}
 * @returns {string} Job ID
 */
function queueBulkSMS(recipients) {
  return addJob('bulk-sms', { recipients }, { priority: 5 });
}

/**
 * Get job status
 * @param {string} jobId - Job ID
 * @returns {object|null} Job status or null if not found
 */
function getJobStatus(jobId) {
  if (processingJobs.has(jobId)) {
    return processingJobs.get(jobId);
  }
  if (completedJobs.has(jobId)) {
    return completedJobs.get(jobId);
  }
  if (failedJobs.has(jobId)) {
    return failedJobs.get(jobId);
  }
  
  // Check if still in queue
  const queuedJob = jobQueue.find(j => j.id === jobId);
  if (queuedJob) {
    return { ...queuedJob, status: 'queued' };
  }
  
  return null;
}

/**
 * Get queue statistics
 * @returns {object} Queue stats
 */
function getStats() {
  return {
    queued: jobQueue.length,
    processing: processingJobs.size,
    completed: completedJobs.size,
    failed: failedJobs.size,
    isProcessing,
  };
}

/**
 * Clear completed jobs history
 */
function clearCompleted() {
  const count = completedJobs.size;
  completedJobs.clear();
  console.log(`[Queue] Cleared ${count} completed jobs`);
  return count;
}

/**
 * Clear failed jobs history
 */
function clearFailed() {
  const count = failedJobs.size;
  failedJobs.clear();
  console.log(`[Queue] Cleared ${count} failed jobs`);
  return count;
}

/**
 * Get all jobs by status
 * @param {string} status - Job status (queued, processing, completed, failed)
 * @returns {Array} Array of jobs
 */
function getJobsByStatus(status) {
  switch (status) {
    case 'queued':
      return jobQueue;
    case 'processing':
      return Array.from(processingJobs.values());
    case 'completed':
      return Array.from(completedJobs.values());
    case 'failed':
      return Array.from(failedJobs.values());
    default:
      return [];
  }
}

// ── Auto-start queue processor ────────────────────────────────────────────────
setInterval(() => {
  if (jobQueue.length > 0 && !isProcessing) {
    processQueue();
  }
}, 1000);

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Queue] Shutting down gracefully...');
  console.log(`[Queue] ${jobQueue.length} jobs still in queue`);
  console.log(`[Queue] ${processingJobs.size} jobs still processing`);
});

module.exports = {
  addJob,
  queueSMS,
  queueBulkSMS,
  getJobStatus,
  getStats,
  clearCompleted,
  clearFailed,
  getJobsByStatus,
};
