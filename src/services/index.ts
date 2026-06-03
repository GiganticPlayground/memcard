import { MemcardService } from './memcard.service';
import { S3StateStore } from './s3.service';

export const memcardService = new MemcardService(new S3StateStore());
