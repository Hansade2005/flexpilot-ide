import * as vscode from 'vscode';
import {
    createFile, editFile, deleteFile, runTerminalCommand,
    CreateFileParams, EditFileParams, DeleteFileParams, RunCommandParams,
    ToolResult
} from './tools';

// Interface for internal representation of tool calls, matching user's example
interface ToolCall {
    id: string;
    name: string;
    parameters: object;
}

// --- Tool Definitions for LLM ---

export const CREATE_FILE_TOOL: vscode.LanguageModelChatTool = {
    name: 'create_file',
    description: 'Creates a new file at the specified path with optional content. Path should be relative to the workspace root. Fails if the file already exists.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the new file (e.g., "src/newFile.ts").' },
            content: { type: 'string', description: 'Optional initial content for the file.' }
        },
        required: ['path']
    }
};

export const EDIT_FILE_TOOL: vscode.LanguageModelChatTool = {
    name: 'edit_file',
    description: 'Edits an existing file by overwriting its content. Path should be relative to the workspace root. Fails if the file does not exist.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file to be edited (e.g., "src/existingFile.ts").' },
            content: { type: 'string', description: 'The new content for the file.' }
        },
        required: ['path', 'content']
    }
};

export const DELETE_FILE_TOOL: vscode.LanguageModelChatTool = {
    name: 'delete_file',
    description: 'Deletes a file at the specified path. Path should be relative to the workspace root. Fails if the file does not exist.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file to be deleted (e.g., "src/obsoleteFile.ts").' }
        },
        required: ['path']
    }
};

export const RUN_TERMINAL_COMMAND_TOOL: vscode.LanguageModelChatTool = {
    name: 'run_terminal_command',
    description: 'Runs a command in the integrated terminal. Does not capture output directly, but indicates if the command was sent.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The command to run (e.g., "npm", "ls", "python").' },
            args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional array of arguments for the command (e.g., ["install", "my-package"]).'
            }
        },
        required: ['command']
    }
};

// Array of all available tools for easy passing to the LLM handler
export const ALL_TOOLS: vscode.LanguageModelChatTool[] = [
    CREATE_FILE_TOOL,
    EDIT_FILE_TOOL,
    DELETE_FILE_TOOL,
    RUN_TERMINAL_COMMAND_TOOL
];

// Interface for internal representation of chat messages, matching user's example
interface ChatMessage {
    role: 'system' | 'user' | 'assistant'; // System role added for completeness
    content: string;
    tool_calls?: ToolCall[]; // Optional tool calls
}

export class VsCodeLmHandler {
    private client: vscode.LanguageModelChat | null = null;
    private cancellationToken: vscode.CancellationTokenSource | null = null;
    private initialized: boolean = false;

    constructor(private modelSelector: { [key: string]: string } = {}) {}

    public isInitialized(): boolean {
        return this.initialized && !!this.client;
    }

    public getClient(): vscode.LanguageModelChat | null {
        return this.client;
    }

    async initialize(): Promise<void> {
        try {
            const models = await vscode.lm.selectChatModels(this.modelSelector);
            this.client = models?.[0] ?? null;
            if (!this.client) {
                this.initialized = false; // Explicitly set on failure
                // vscode.window.showErrorMessage('No matching language models found for Flexpilot Agent.');
                console.error('No matching language models found for selector:', this.modelSelector);
                throw new Error('No matching language models found');
            }
            this.initialized = true; // Set on success
            console.info(`Flexpilot Agent initialized with model: ${this.client.id} (Vendor: ${this.client.vendor}, Version: ${this.client.version}, Family: ${this.client.family})`);
        } catch (error) {
            this.initialized = false; // Explicitly set on failure
            // vscode.window.showErrorMessage(`Failed to initialize VS Code LM for Flexpilot Agent: ${error instanceof Error ? error.message : String(error)}`);
            console.error(`Failed to initialize VS Code LM: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to initialize VS Code LM: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Corrected createVscodeMessages to better handle string content vs tool_calls
    private createVscodeMessages_corrected(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
        return messages.map(msg => {
            const vscodeRole = msg.role === 'user'
                ? vscode.LanguageModelChatMessageRole.User
                : vscode.LanguageModelChatMessageRole.Assistant;

            let contentValue: string | vscode.LanguageModelChatMessagePart[];
            let messageName: string | undefined = undefined;

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                contentValue = msg.tool_calls.map(toolCall =>
                    // Correct constructor: new vscode.LanguageModelToolCallPart(name, id, input)
                    new vscode.LanguageModelToolCallPart(toolCall.name, toolCall.id, toolCall.parameters)
                );
                // If the assistant's message consists of tool calls, the 'name' property of LanguageModelChatMessage
                // might be expected to be the name of the tool that was called.
                // This is a bit ambiguous from the error, but let's assume if there's one tool call, we use its name.
                // If multiple, this might need a more sophisticated approach or be left undefined.
                // For now, let's leave messageName as undefined unless a clear requirement emerges.
                // The error "Property 'name' is missing" usually applies when role is Assistant and content has tool calls.
                // It might refer to the tool name that is being called.
                // Let's assume for now it's not required on the message itself if the LanguageModelToolCallPart has the name.
                // The LanguageModelChatMessage constructor itself allows 'name' as an optional third param.
            } else {
                contentValue = msg.content; // Simple string content
            }

            // Construct vscode.LanguageModelChatMessage
            // constructor(role: LanguageModelChatMessageRole, content: string | LanguageModelChatMessagePart[], name?: string)
            if (vscodeRole === vscode.LanguageModelChatMessageRole.Assistant && msg.tool_calls && msg.tool_calls.length > 0) {
                // If there are tool_calls, the LanguageModelChatMessage from an assistant might need a name.
                // However, the 'name' on LanguageModelChatMessage is typically for the *result* of a tool call,
                // not the call itself. Let's test by not providing it first, and if error persists, add it.
                // The error "Property 'name' is missing" was on the array, suggesting the objects within are missing it.
                // This implies the constructor needs it. Let's try adding it for assistant tool calls.
                // If there are multiple tool calls, what name to use? This is tricky.
                // The 'name' on LanguageModelChatMessage is more for tool *results*.
                // Let's assume the error is simpler: the object literal needs to match the class constructor if used that way.
                // The return { role, content } was creating an object literal.
                // Let's use the actual class constructor for clarity and potential type enforcement.
                // The error "Property 'name' is missing" suggests that the object literal {role, content} is not satisfying
                // the type if the role is Assistant and content contains tool calls.
                // The 'name' field is optional on LanguageModelChatMessage.
                // The error is likely because the LanguageModelChatMessage[] is expected to contain objects that fully satisfy the type.
                // For assistant messages with tool calls, 'name' might be implicitly required by some internal VS Code logic,
                // even if optional in the class def. This usually refers to the name of the tool in the tool call.
                // Let's set 'name' if it's an assistant message with tool calls.
                // If there are multiple tool calls, we'll use the name of the first one. This is an assumption.
                if (msg.tool_calls.length > 0) {
                    // messageName = msg.tool_calls[0].name; // This is an assumption for the 'name' field of the message.
                    // Let's try creating it without the name first, as the ToolCallPart has the name.
                    // The error "Property 'name' is missing" might be from a strict check when role is Assistant + tool calls.
                    // It's safer to add it if it's an assistant message with tool calls.
                     return new vscode.LanguageModelChatMessage(vscodeRole, contentValue, msg.tool_calls[0].name);

                } else {
                    return new vscode.LanguageModelChatMessage(vscodeRole, contentValue);
                }
            } else {
                 return new vscode.LanguageModelChatMessage(vscodeRole, contentValue);
            }
        });
    }


    async *chat(
        messages: ChatMessage[],
        tools?: vscode.LanguageModelChatTool[],
        options: {
            toolMode?: vscode.LanguageModelChatToolMode;
            systemPrompt?: string;
        } = {}
    ): AsyncIterable<{ type: 'text' | 'tool_call'; content: string | ToolCall }> {
        if (!this.client) {
            throw new Error('Language model client not initialized');
        }

        const allVscodeMessages: vscode.LanguageModelChatMessage[] = [];
        if (options.systemPrompt) {
            // System prompts in VSCode LM API are typically the first message with User/Assistant role
            // or handled differently by models. Some models prefer system prompt as first User message.
            // For this generic handler, let's assume a system prompt is added as the first message.
            // The API itself doesn't have a dedicated 'system' role in LanguageModelChatMessage.
            // The common pattern is:
            // 1. User: System instructions
            // 2. Assistant: Okay
            // 3. User: Actual prompt
            // Or, some models just take the system prompt as part of the initial user message, or an option.
            // The user's `declare module` doesn't add a System role to `LanguageModelChatMessageRole`.
            // So, we will add it as the first message to the `messages` array before conversion.
             allVscodeMessages.push(...this.createVscodeMessages_corrected([{role: 'user', content: options.systemPrompt}, ...messages]));
        } else {
            allVscodeMessages.push(...this.createVscodeMessages_corrected(messages));
        }


        this.cancellationToken = new vscode.CancellationTokenSource();
        const requestOptions: vscode.LanguageModelChatRequestOptions = {
            tools, // from parameter
            toolMode: options.toolMode, // from parameter
            justification: 'Flexpilot Agent request' // Custom justification
        };

        try {
            const response = await this.client.sendRequest(
                allVscodeMessages,
                requestOptions,
                this.cancellationToken.token
            );

            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    yield { type: 'text', content: chunk.value };
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    yield {
                        type: 'tool_call',
                        content: {
                            id: chunk.id, // Corrected: LanguageModelToolCallPart has 'id'
                            name: chunk.name,
                            parameters: chunk.input // Corrected: LanguageModelToolCallPart has 'input'
                        }
                    };
                }
            }
        } finally {
            this.cancellationToken.dispose();
            this.cancellationToken = null;
        }
    }

    async complete(
        prompt: string,
        systemPrompt?: string,
        availableTools: vscode.LanguageModelChatTool[] = ALL_TOOLS // Default to all defined tools
    ): Promise<{ text?: string; tool_calls?: ToolCall[]; tool_results?: { callId: string; result: ToolResult }[] }> {
        let text = '';
        const tool_calls: ToolCall[] = [];
        const tool_results: { callId: string; result: ToolResult }[] = [];

        // Use the systemPrompt and availableTools in the options for the chat method
        for await (const chunk of this.chat(
            [{ role: 'user', content: prompt }],
            availableTools, // Pass available tools to chat method
            { systemPrompt } // Pass systemPrompt to chat options
        )) {
            if (chunk.type === 'text') {
                text += chunk.content;
            } else if (chunk.type === 'tool_call') {
                const toolCallData = chunk.content as ToolCall; // ToolCall is {id, name, parameters}
                tool_calls.push(toolCallData); // Record the requested tool call

                let toolExecutionResult: ToolResult;
                try {
                    switch (toolCallData.name) {
                        case CREATE_FILE_TOOL.name:
                            toolExecutionResult = await createFile(toolCallData.parameters as CreateFileParams);
                            break;
                        case EDIT_FILE_TOOL.name:
                            toolExecutionResult = await editFile(toolCallData.parameters as EditFileParams);
                            break;
                        case DELETE_FILE_TOOL.name:
                            toolExecutionResult = await deleteFile(toolCallData.parameters as DeleteFileParams);
                            break;
                        case RUN_TERMINAL_COMMAND_TOOL.name:
                            toolExecutionResult = await runTerminalCommand(toolCallData.parameters as RunCommandParams);
                            break;
                        default:
                            console.error(`Unknown tool called: ${toolCallData.name}`);
                            toolExecutionResult = { success: false, error: `Unknown tool: ${toolCallData.name}` };
                    }
                } catch (error: any) {
                    console.error(`Error executing tool ${toolCallData.name}:`, error);
                    toolExecutionResult = { success: false, error: `Error executing tool ${toolCallData.name}: ${error.message || String(error)}` };
                }
                tool_results.push({ callId: toolCallData.id, result: toolExecutionResult });
            }
        }

        return {
            ...(text && { text }), // Add text if it exists
            ...(tool_calls.length > 0 && { tool_calls }), // Add tool_calls if any
            ...(tool_results.length > 0 && { tool_results }) // Add tool_results if any
        };
    }

    cancel(): void {
        this.cancellationToken?.cancel();
    }

    dispose(): void {
        this.cancel();
        // this.client = null; // Client is managed by VS Code, not for us to null out usually.
                           // Disposing cancellation token is the main action.
    }
}
