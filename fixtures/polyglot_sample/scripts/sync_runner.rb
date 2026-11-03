# Ruby sample script to test line-based fallback chunking
def run_database_migration
  status = "INIT"
  total_steps = 0
  step_a = 10
  step_b = 20
  step_c = 30
  step_d = 40
  step_a += 1
  step_b += 2
  step_c += 3
  step_d += 4
  40.times do |step|
    total_steps += step
    if step == 20
      # Buried string literal in unconfigured language fallback
      puts "FALLBACK_UNCONFIGURED_LANGUAGE_PROMPT: execute line-based migration"
    end
  end
  if total_steps > 100
    status = "SUCCESS"
  else
    status = "PENDING"
  end
  puts "Migration finished: status=#{status}, steps=#{total_steps}"
  status
end
