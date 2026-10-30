import { readFile } from "fs/promises";
import path from "path";

import { UploadFile } from "@linear/sdk";
import { fileTypeFromFile } from "file-type";

import { getLinearClient } from "./linearClient";

export async function uploadFile(filePath: string) {
  const { graphQLClient } = getLinearClient();

  const buffer = await readFile(filePath);
  const type = await fileTypeFromFile(filePath);
  const contentType = type?.mime ?? "application/octet-stream";
  const file = new Blob([buffer], { type: contentType });
  const name = path.basename(filePath);

  const { data } = await graphQLClient.rawRequest<
    {
      fileUpload: { uploadFile: UploadFile };
    },
    Record<string, unknown>
  >(
    `
      mutation ($size: Int!, $contentType: String!, $filename: String!) {
        fileUpload(size: $size, contentType: $contentType, filename: $filename) {
          uploadFile {
            headers {
              key
              value
            }
            uploadUrl
            assetUrl
          }
        }
      }
    `,
    { size: file.size, contentType, filename: name },
  );

  const uploadFile = data?.fileUpload.uploadFile;
  const uploadUrl = uploadFile?.uploadUrl;

  if (uploadUrl && uploadFile.headers.length > 0) {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    };
    for (const { key, value } of uploadFile.headers) {
      headers[key] = value;
    }

    const response = await fetch(uploadUrl, { method: "PUT", headers, body: buffer });
    if (!response.ok) {
      throw new Error(`Upload of ${name} failed: ${response.status} ${response.statusText}`);
    }

    return { assetUrl: uploadFile.assetUrl, name };
  }
}

export type CreateAttachmentPayload = {
  issueId: string;
  url: string;
};

export async function createAttachment(payload: CreateAttachmentPayload) {
  const { graphQLClient } = getLinearClient();

  const file = await uploadFile(payload.url);

  if (!file) {
    throw new Error("Unable to upload file");
  }

  const attachmentInput = `issueId: "${payload.issueId}", title: "${file.name}", url: "${file.assetUrl}"`;

  const { data } = await graphQLClient.rawRequest<
    { attachmentCreate: { success: boolean; attachment: { id: string } } },
    Record<string, unknown>
  >(
    `
      mutation {
        attachmentCreate(input: { ${attachmentInput} }) {
          success
          attachment {
            id
          }
        }
      }
    `,
  );

  return { success: data?.attachmentCreate.success, id: data?.attachmentCreate.attachment.id };
}

export async function attachLinkUrl(payload: CreateAttachmentPayload) {
  const { graphQLClient } = getLinearClient();

  const attachmentInput = `issueId: "${payload.issueId}", url: "${payload.url}"`;

  const { data } = await graphQLClient.rawRequest<
    { attachmentLinkURL: { success: boolean; attachment: { id: string } } },
    Record<string, unknown>
  >(
    `
      mutation {
        attachmentLinkURL(${attachmentInput}) {
          success
          attachment {
            id
          }
        }
      }
    `,
  );

  return { success: data?.attachmentLinkURL.success, id: data?.attachmentLinkURL.attachment.id };
}
