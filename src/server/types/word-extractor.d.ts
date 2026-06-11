declare module "word-extractor" {
  export interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<WordDocument>;
  }
}
