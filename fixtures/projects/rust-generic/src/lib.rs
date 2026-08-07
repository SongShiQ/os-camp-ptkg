#![no_std]

pub struct JobQueue {
    pending: usize,
}

impl JobQueue {
    pub const fn new() -> Self {
        Self { pending: 0 }
    }

    pub fn enqueue(&mut self) {
        self.pending += 1;
    }

    pub fn pending(&self) -> usize {
        self.pending
    }
}

impl Default for JobQueue {
    fn default() -> Self {
        Self::new()
    }
}
