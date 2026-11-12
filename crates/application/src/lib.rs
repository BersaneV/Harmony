//! Application ports do not depend on HTTP, SQL, Tokio or media SDKs.
use async_trait::async_trait;
use harmony_domain::{Message, Result, SendMessage};
use uuid::Uuid;

#[async_trait]
pub trait ConversationRepository: Send + Sync {
    /// Authorization, channel lock, idempotency, sequence and outbox are one transaction.
    async fn commit_message(
        &self,
        actor: Uuid,
        channel: Uuid,
        command: SendMessage,
    ) -> Result<Message>;
}
pub struct ChatService<R>(pub R);
impl<R: ConversationRepository> ChatService<R> {
    pub async fn send(&self, actor: Uuid, channel: Uuid, command: SendMessage) -> Result<Message> {
        harmony_domain::message(&command)?;
        self.0.commit_message(actor, channel, command).await
    }
}
