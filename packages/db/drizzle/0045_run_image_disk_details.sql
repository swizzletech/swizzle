UPDATE "workers"
SET "run_image_disk" = ("run_image_disk" - 'unmeasuredActiveImages' - 'unmeasuredActiveImagesOmitted')
  || jsonb_build_object(
    'unmeasured', jsonb_build_object(
      'images', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('id', image->'id', 'tag', image->'tags'->0)
          ORDER BY position
        )
        FROM jsonb_array_elements("run_image_disk"->'unmeasuredActiveImages')
          WITH ORDINALITY AS details(image, position)
      ), '[]'::jsonb),
      'total', LEAST(
        COALESCE(("run_image_disk"->>'unmeasuredActiveImagesOmitted')::bigint, 0)
          + COALESCE(jsonb_array_length("run_image_disk"->'unmeasuredActiveImages'), 0),
        9007199254740991
      )
    )
  )
WHERE jsonb_typeof("run_image_disk") = 'object' AND NOT ("run_image_disk" ? 'unmeasured');
