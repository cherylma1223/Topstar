const stripVIPContentForSpeech = (text) => {
    const lines = text.split('\n');
    const resultLines = [];
    let isInsideVIPSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
            if (!isInsideVIPSection) resultLines.push(line);
            continue;
        }

        const headerMatch = line.match(/【([^】]+)】/);

        if (headerMatch) {
            const title = headerMatch[1];
            isInsideVIPSection = title.includes('VIP') || title.includes('秘诀');
        }

        if (!isInsideVIPSection) {
            resultLines.push(line);
        }
    }

    return resultLines.join('\n').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
};

const text = `
你好！我是你的乒乓球教练。反手拧拉是现代乒乓球最核心的进攻技术之一。想要练好这一招，必须做到“支点稳、引拍深、摩擦薄”。

以下是为你整理的【反手拧拉】技术动作指南：

【动作要领】
*   **引拍**：跨度要大。
*   **摩擦**：薄摩擦。

【常见误区与专家建议】
*   **问题**：容易出界。
    *   **建议**：内扣不够深。

【视频教程】
[张继科拧拉动作慢动作示范](https://drive.google.com/file/d/13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0/view)

【核心秘诀(VIP专属)】
**食指的“二次点火”发力**：
在球拍接触球的那百分之一秒，手腕外展的同时，**食指猛地压一下拍肩**。这个细微的动作能为球体增加一个极强的二次加速度。

【结语】
加油，你可以的！
`;

console.log("Original Length:", text.length);
const result = stripVIPContentForSpeech(text);
console.log("Result Length:", result.length);
console.log("--- Result ---");
console.log(result);
