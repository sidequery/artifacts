import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type StoredObject = { body: Uint8Array; etag: string };

/** Bucket-relative keys use the same prefix as the celld nodes. */
export class FleetStore {
  readonly bucket: string;
  readonly prefix: string;
  constructor(
    readonly client: S3Client,
    location: string,
  ) {
    const url = new URL(location);
    if (
      url.protocol !== "s3:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Fleet operator requires an S3 bucket URL");
    this.bucket = url.hostname;
    this.prefix = decodeURIComponent(url.pathname).replace(/^\/|\/$/g, "");
    if (this.prefix.split("/").some((part) => part === "." || part === ".."))
      throw new Error("Invalid fleet bucket prefix");
  }
  key(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
  async read(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (!result.Body || !result.ETag)
        throw new Error("Fleet object has no body or ETag");
      return {
        body: await result.Body.transformToByteArray(),
        etag: result.ETag,
      };
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return undefined;
      throw error;
    }
  }
  async json<T>(key: string): Promise<{ value: T; etag: string } | undefined> {
    const result = await this.read(key);
    return result
      ? {
          value: JSON.parse(new TextDecoder().decode(result.body)) as T,
          etag: result.etag,
        }
      : undefined;
  }
  async put(key: string, value: unknown, expected?: string | null) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: JSON.stringify(value),
        ContentType: "application/json",
        ...(expected === null
          ? { IfNoneMatch: "*" }
          : expected
            ? { IfMatch: expected }
            : {}),
      }),
    );
  }
  async keys(prefix: string) {
    const keys: string[] = [];
    let continuation: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.key(prefix),
          ContinuationToken: continuation,
        }),
      );
      for (const object of page.Contents ?? [])
        if (object.Key)
          keys.push(object.Key.slice(this.prefix ? this.prefix.length + 1 : 0));
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuation)
        throw new Error("Invalid fleet bucket pagination");
    } while (continuation);
    return keys;
  }
  async copyImmutable(source: string, target: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(target) }),
      );
      return;
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw error;
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: this.key(target),
        CopySource: `${this.bucket}/${this.key(source).split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
  }
}
