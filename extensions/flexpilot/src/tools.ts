import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Parameters for creating a file.
 * path: Absolute path or path relative to the workspace root.
 * content: Optional content for the new file.
 */
export interface CreateFileParams {
    path: string;
    content?: string;
}

/**
 * Parameters for editing/overwriting a file.
 * path: Absolute path or path relative to the workspace root.
 * content: New content for the file.
 */
export interface EditFileParams {
    path: string;
    content: string;
}

/**
 * Parameters for deleting a file.
 * path: Absolute path or path relative to the workspace root.
 */
export interface DeleteFileParams {
    path: string;
}

/**
 * Parameters for running a terminal command.
 * command: The command to run (e.g., 'npm', 'ls').
 * args: Optional array of arguments for the command.
 */
export interface RunCommandParams {
    command: string;
    args?: string[];
}

/**
 * Generic result structure for tool operations.
 * success: Boolean indicating if the operation was successful.
 * message: Optional message providing details about the success.
 * error: Optional message providing details about the failure.
 * data: Optional additional data returned by the tool.
 */
export interface ToolResult {
    success: boolean;
    message?: string;
    error?: string;
    data?: any;
}

function getAbsolutePathUri(relativePath: string): vscode.Uri {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        logger.info('No workspace folder open, interpreting path as absolute.');
        return vscode.Uri.file(relativePath);
    }
    const workspaceRoot = workspaceFolders[0].uri;
    const absolutePath = vscode.Uri.joinPath(workspaceRoot, relativePath);
    logger.info(`Resolved path ${relativePath} to ${absolutePath.fsPath} using workspace root ${workspaceRoot.fsPath}`);
    return absolutePath;
}

/**
 * Creates a new file.
 * @param params Parameters for creating the file.
 * @returns A ToolResult indicating success or failure.
 */
export async function createFile(params: CreateFileParams): Promise<ToolResult> {
    logger.info(`createFile invoked with params: ${JSON.stringify(params)}`);
    try {
        const fileUri = getAbsolutePathUri(params.path);
        logger.info(`Attempting to create file at URI: ${fileUri.toString()}`);
        const contentBytes = new TextEncoder().encode(params.content || '');

        try {
            await vscode.workspace.fs.stat(fileUri);
            logger.warn(`File already exists at ${params.path} (URI: ${fileUri.toString()}). createFile will not overwrite.`);
            return { success: false, error: `File already exists: ${params.path}` };
        } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                // This is expected, file does not exist, proceed to create.
                logger.info(`File does not exist at ${fileUri.toString()}, proceeding with creation.`);
            } else {
                 logger.error(`Error stating file ${fileUri.toString()} before creation:`, error);
                 throw error;
            }
        }

        await vscode.workspace.fs.writeFile(fileUri, contentBytes);
        logger.info(`File created successfully: ${params.path} (URI: ${fileUri.toString()})`);
        return { success: true, message: `File created: ${params.path}` };
    } catch (error: any) {
        logger.error(`Error in createFile for ${params.path}: ${error.message || String(error)}`, error);
        return { success: false, error: `Failed to create file ${params.path}: ${error.message || String(error)}` };
    }
}

/**
 * Edits/overwrites an existing file with new content.
 * @param params Parameters for editing the file.
 * @returns A ToolResult indicating success or failure.
 */
export async function editFile(params: EditFileParams): Promise<ToolResult> {
    logger.info(`editFile invoked with params: ${JSON.stringify(params)}`);
    try {
        const fileUri = getAbsolutePathUri(params.path);
        logger.info(`Attempting to edit file at URI: ${fileUri.toString()}`);
        const contentBytes = new TextEncoder().encode(params.content);

        try {
            await vscode.workspace.fs.stat(fileUri);
            logger.info(`File found at ${fileUri.toString()}, proceeding with edit.`);
        } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                logger.warn(`File not found at ${params.path} (URI: ${fileUri.toString()}). editFile cannot edit non-existent file.`);
                return { success: false, error: `File not found: ${params.path}` };
            }
            logger.error(`Error stating file ${fileUri.toString()} before edit:`, error);
            throw error;
        }

        await vscode.workspace.fs.writeFile(fileUri, contentBytes); // This overwrites.
        logger.info(`File edited successfully: ${params.path} (URI: ${fileUri.toString()})`);
        return { success: true, message: `File edited: ${params.path}` };
    } catch (error: any) {
        logger.error(`Error in editFile for ${params.path}: ${error.message || String(error)}`, error);
        return { success: false, error: `Failed to edit file ${params.path}: ${error.message || String(error)}` };
    }
}

/**
 * Deletes a file.
 * @param params Parameters for deleting the file.
 * @returns A ToolResult indicating success or failure.
 */
export async function deleteFile(params: DeleteFileParams): Promise<ToolResult> {
    logger.info(`deleteFile invoked with params: ${JSON.stringify(params)}`);
    try {
        const fileUri = getAbsolutePathUri(params.path);
        logger.info(`Attempting to delete file at URI: ${fileUri.toString()}`);

        await vscode.workspace.fs.delete(fileUri, { useTrash: false }); // useTrash: false for direct deletion
        logger.info(`File deleted successfully: ${params.path} (URI: ${fileUri.toString()})`);
        return { success: true, message: `File deleted: ${params.path}` };
    } catch (error: any) {
        logger.error(`Error in deleteFile for ${params.path}: ${error.message || String(error)}`, error);
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
             logger.warn(`File not found at ${params.path} (URI: ${getAbsolutePathUri(params.path).toString()}). Cannot delete.`);
             return { success: false, error: `File not found: ${params.path}` };
        }
        return { success: false, error: `Failed to delete file ${params.path}: ${error.message || String(error)}` };
    }
}

/**
 * Runs a command in a new terminal.
 * @param params Parameters for running the command.
 * @returns A ToolResult indicating success or failure to send the command. Output is not captured.
 */
export async function runTerminalCommand(params: RunCommandParams): Promise<ToolResult> {
    logger.info(`runTerminalCommand invoked with params: ${JSON.stringify(params)}`);
    try {
        // For simplicity, create a new terminal or use a dedicated one.
        // Let's use a dedicated one to avoid proliferation.
        let terminal = vscode.window.terminals.find(t => t.name === "Flexpilot Task Terminal");
        if (!terminal) {
            logger.info('Creating new terminal: Flexpilot Task Terminal');
            terminal = vscode.window.createTerminal("Flexpilot Task Terminal");
        } else {
            logger.info('Reusing existing terminal: Flexpilot Task Terminal');
        }

        terminal.show(true); // true to preserve focus on the editor

        const fullCommand = params.args ? `${params.command} ${params.args.join(' ')}` : params.command;
        terminal.sendText(fullCommand);

        // As per plan, direct output capturing is complex.
        // This simplified version confirms command sending.
        logger.info(`Command sent to terminal: ${fullCommand}`);
        return {
            success: true,
            message: `Command '${fullCommand}' sent to terminal 'Flexpilot Task Terminal'. Output should be checked in the terminal.`
        };
    } catch (error: any) {
        logger.error(`Error in runTerminalCommand for command '${params.command}': ${error.message || String(error)}`, error);
        return {
            success: false,
            error: `Failed to send command '${params.command}' to terminal: ${error.message || String(error)}`
        };
    }
}

// Export all implemented tool functions.
export { createFile, editFile, deleteFile, runTerminalCommand };
