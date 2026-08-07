use job_queue_kernel::JobQueue;

#[test]
fn enqueue_increases_pending_count() {
    let mut queue = JobQueue::new();
    queue.enqueue();
    assert_eq!(queue.pending(), 1);
}
