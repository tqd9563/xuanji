/** M1 占位:派发通道(Agent SDK 对话 + canUseTool 审批 + resume + 转后台)在 M2 落地。 */
export function Dispatch() {
  return (
    <>
      <div className="view-head">
        <h1>派发</h1>
      </div>
      <div className="dispatch">
        <div className="chat">
          <div className="chat-empty">
            <h2>派发通道在 M2 开放</h2>
            <p>
              届时:Agent SDK 流式对话、工具调用折叠卡、canUseTool 审批卡、--resume 续接、转后台(--bg)、
              跨目录携带摘要交接。当前里程碑(M1)专注只读驾驶舱——会话看板与回放已可用。
            </p>
            <div className="sugg">
              <button onClick={() => (location.hash = 'sessions')}>去会话看板(3)</button>
              <button onClick={() => (location.hash = 'dashboard')}>回仪表盘(1)</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
